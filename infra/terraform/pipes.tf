# DynamoDB stream -> SQS delivery. Target input is built with a template, and there's no
# enrichment step, so a Map attribute arrives as DynamoDB JSON. The runner decodes it.

data "aws_iam_policy_document" "pipes_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["pipes.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

data "aws_iam_policy_document" "pipe_stream_read" {
  statement {
    sid       = "StreamRead"
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"]
    resources = [aws_dynamodb_table.main.stream_arn]
  }
}

# ---------- Outbox: R2's job intent -> jobs queue ----------

resource "aws_iam_role" "pipe_outbox" {
  name               = "cht-nocode-pipe-outbox"
  assume_role_policy = data.aws_iam_policy_document.pipes_assume_role.json
}

data "aws_iam_policy_document" "pipe_outbox" {
  source_policy_documents = [data.aws_iam_policy_document.pipe_stream_read.json]

  statement {
    sid       = "SendToJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "pipe_outbox" {
  name   = "cht-nocode-pipe-outbox"
  role   = aws_iam_role.pipe_outbox.id
  policy = data.aws_iam_policy_document.pipe_outbox.json
}

resource "aws_pipes_pipe" "outbox" {
  name     = "cht-nocode-outbox"
  role_arn = aws_iam_role.pipe_outbox.arn
  source   = aws_dynamodb_table.main.stream_arn
  target   = aws_sqs_queue.jobs.arn

  source_parameters {
    dynamodb_stream_parameters {
      starting_position = "LATEST"
      batch_size        = 1
    }

    filter_criteria {
      filter {
        # DRAFT_LOGIC is left out until there's a worker for it.
        pattern = jsonencode({
          eventName = ["INSERT"]
          dynamodb = {
            Keys     = { sk = { S = ["OUTBOX"] } }
            NewImage = { jobType = { S = ["COMPILE_LOGIC", "VERIFY_BUILD"] } }
          }
        })
      }
    }
  }

  target_parameters {
    input_template = "<$.dynamodb.NewImage.payload>"
  }

  depends_on = [aws_iam_role_policy.pipe_outbox]
}

# ---------- Events: JOB META status changes -> job-events queue ----------

resource "aws_iam_role" "pipe_job_events" {
  name               = "cht-nocode-pipe-job-events"
  assume_role_policy = data.aws_iam_policy_document.pipes_assume_role.json
}

data "aws_iam_policy_document" "pipe_job_events" {
  source_policy_documents = [data.aws_iam_policy_document.pipe_stream_read.json]

  statement {
    sid       = "SendToJobEvents"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.job_events.arn]
  }
}

resource "aws_iam_role_policy" "pipe_job_events" {
  name   = "cht-nocode-pipe-job-events"
  role   = aws_iam_role.pipe_job_events.id
  policy = data.aws_iam_policy_document.pipe_job_events.json
}

resource "aws_pipes_pipe" "job_events" {
  name     = "cht-nocode-job-events"
  role_arn = aws_iam_role.pipe_job_events.arn
  source   = aws_dynamodb_table.main.stream_arn
  target   = aws_sqs_queue.job_events.arn

  source_parameters {
    dynamodb_stream_parameters {
      starting_position = "LATEST"
      batch_size        = 1
    }

    filter_criteria {
      # A pattern can't compare two attributes, so there's one filter per new status.
      # This keeps lease heartbeats, which rewrite META at the same status, off the queue.
      dynamic "filter" {
        for_each = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
        content {
          pattern = jsonencode({
            eventName = ["MODIFY"]
            dynamodb = {
              Keys = {
                pk = { S = [{ prefix = "JOB#" }] }
                sk = { S = ["META"] }
              }
              NewImage = { status = { S = [filter.value] } }
              OldImage = { status = { S = [{ anything-but = [filter.value] }] } }
            }
          })
        }
      }
    }
  }

  target_parameters {
    input_template = "{\"jobId\":\"<$.dynamodb.NewImage.jobId.S>\",\"status\":\"<$.dynamodb.NewImage.status.S>\",\"attempt\":<$.dynamodb.NewImage.attempt.N>}"
  }

  depends_on = [aws_iam_role_policy.pipe_job_events]
}
