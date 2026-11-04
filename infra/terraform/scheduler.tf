# Stops only the instances this Terraform creates. Never touches the Kiro
# workspace instance (i-039648f03266104f5) or anything else in the account.

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "stop_scheduler" {
  name               = "cht-nocode-stop-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
}

data "aws_iam_policy_document" "stop_scheduler" {
  statement {
    sid     = "StopOnlyOurInstances"
    actions = ["ec2:StopInstances"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.app_host.id}",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.cht_host.id}",
    ]
  }
}

resource "aws_iam_role_policy" "stop_scheduler" {
  name   = "cht-nocode-stop-scheduler-policy"
  role   = aws_iam_role.stop_scheduler.id
  policy = data.aws_iam_policy_document.stop_scheduler.json
}

resource "aws_scheduler_schedule" "nightly_stop" {
  name                         = "cht-nocode-nightly-stop"
  schedule_expression          = "cron(0 23 * * ? *)"
  schedule_expression_timezone = var.stop_schedule_timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.stop_scheduler.arn

    input = jsonencode({
      InstanceIds = [aws_instance.app_host.id, aws_instance.cht_host.id]
    })
  }
}
