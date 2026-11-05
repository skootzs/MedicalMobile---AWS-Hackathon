resource "aws_cloudwatch_log_group" "app" {
  name              = "/cht-nocode/app"
  retention_in_days = 7

  tags = {
    Name = "cht-nocode-app-logs"
  }
}

resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "cht-nocode-error-count"
  log_group_name = aws_cloudwatch_log_group.app.name
  # A term with non-alphanumeric characters has to be quoted to match.
  pattern = "\"level=error\""

  metric_transformation {
    name      = "ErrorCount"
    namespace = "CHTNoCode"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_sns_topic" "alerts" {
  name = "cht-nocode-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "cht-nocode-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ErrorCount"
  namespace           = "CHTNoCode"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Fires when any level=error log line is written."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}
