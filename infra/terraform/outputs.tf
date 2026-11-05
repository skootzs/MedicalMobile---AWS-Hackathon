output "app_host_instance_id" {
  value = aws_instance.app_host.id
}

output "cht_host_instance_id" {
  value = aws_instance.cht_host.id
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.main.name
}

output "dynamodb_stream_arn" {
  value = aws_dynamodb_table.main.stream_arn
}

output "jobs_queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "jobs_dlq_url" {
  value = aws_sqs_queue.jobs_dlq.url
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_user_pool_client_id" {
  value = aws_cognito_user_pool_client.main.id
}

output "ecr_repository_urls" {
  value = { for name, repo in aws_ecr_repository.repos : name => repo.repository_url }
}

output "cht_secret_name" {
  value = aws_secretsmanager_secret.cht_login.name
}

output "bedrock_guardrail_id" {
  value = aws_bedrock_guardrail.pii.guardrail_id
}

output "bedrock_guardrail_version" {
  value = aws_bedrock_guardrail_version.pii.version
}

output "job_events_queue_url" {
  value = aws_sqs_queue.job_events.url
}

output "job_events_dlq_url" {
  value = aws_sqs_queue.job_events_dlq.url
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}

output "intake_environment" {
  value = {
    AWS_REGION           = data.aws_region.current.name
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.intake.id
    COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.intake.id
    COGNITO_HOSTED_URL   = "https://${local.intake_resource_name}.auth.${data.aws_region.current.name}.amazoncognito.com"
    COGNITO_REDIRECT_URI = var.intake_callback_url
    INTAKE_TABLE         = aws_dynamodb_table.intake.name
    INTAKE_BUCKET        = aws_s3_bucket.intake.id
  }
}

output "intake_runtime_policy_arn" {
  value = aws_iam_policy.intake_runtime.arn
}

output "integrated_app_environment" {
  value = merge(local.intake_screening_environment, {
    MODE                 = "aws"
    AWS_REGION           = data.aws_region.current.name
    DDB_TABLE            = aws_dynamodb_table.main.name
    ARTIFACT_BUCKET      = aws_s3_bucket.artifacts.bucket
    JOB_EVENTS_QUEUE_URL = aws_sqs_queue.job_events.url
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
    COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.main.id
    COGNITO_HOSTED_URL   = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
    COGNITO_REDIRECT_URI = "http://localhost:8080"
    INTAKE_TABLE         = aws_dynamodb_table.intake.name
    INTAKE_BUCKET        = aws_s3_bucket.intake.bucket
  })
}
