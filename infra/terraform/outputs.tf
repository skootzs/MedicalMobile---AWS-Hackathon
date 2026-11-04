data "aws_region" "intake" {}

output "intake_environment" {
  value = {
    AWS_REGION           = data.aws_region.intake.region
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.intake.id
    COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.intake.id
    COGNITO_HOSTED_URL   = "https://${var.intake_name}.auth.${data.aws_region.intake.region}.amazoncognito.com"
    COGNITO_REDIRECT_URI = var.intake_callback_url
    INTAKE_TABLE        = aws_dynamodb_table.intake.name
    INTAKE_BUCKET       = aws_s3_bucket.intake.id
  }
}
