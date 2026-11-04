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
