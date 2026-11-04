# Visibility timeout (960s) sits just above LEASE_SECONDS (900s); the runner
# extends it on every heartbeat so a healthy in-flight job never gets redelivered.

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "cht-nocode-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true

  tags = {
    Name = "cht-nocode-jobs-dlq"
  }
}

resource "aws_sqs_queue" "jobs" {
  name                       = "cht-nocode-jobs"
  visibility_timeout_seconds = 960
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name = "cht-nocode-jobs"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "jobs_dlq" {
  queue_url = aws_sqs_queue.jobs_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

# Job status events for R2's reconciler (see pipes.tf).

resource "aws_sqs_queue" "job_events_dlq" {
  name                      = "cht-nocode-job-events-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true

  tags = {
    Name = "cht-nocode-job-events-dlq"
  }
}

resource "aws_sqs_queue" "job_events" {
  name                    = "cht-nocode-job-events"
  sqs_managed_sse_enabled = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.job_events_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    Name = "cht-nocode-job-events"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "job_events_dlq" {
  queue_url = aws_sqs_queue.job_events_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.job_events.arn]
  })
}
