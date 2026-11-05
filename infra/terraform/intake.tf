# Sam's intake app uses its own table, bucket, and user pool. The shared
# orchestrator stack stays in the other files. The name defaults to one that
# is unique per account so a committed tfvars file is not required.

locals {
  intake_resource_name = var.intake_name != "" ? var.intake_name : "cht-nocode-intake-${data.aws_caller_identity.current.account_id}"
}

resource "aws_dynamodb_table" "intake" {
  name         = local.intake_resource_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "pipelineQueue"
    type = "S"
  }

  attribute {
    name = "due"
    type = "N"
  }

  global_secondary_index {
    name               = "pipeline-due"
    hash_key           = "pipelineQueue"
    range_key          = "due"
    projection_type    = "INCLUDE"
    non_key_attributes = ["kind", "revisionId"]
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_s3_bucket" "intake" {
  bucket = local.intake_resource_name
}

resource "aws_s3_bucket_public_access_block" "intake" {
  bucket                  = aws_s3_bucket.intake.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "intake" {
  bucket = aws_s3_bucket.intake.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "intake" {
  bucket = aws_s3_bucket.intake.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cognito_user_pool" "intake" {
  name = local.intake_resource_name

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

resource "aws_cognito_user_pool_client" "intake" {
  name                                 = local.intake_resource_name
  user_pool_id                         = aws_cognito_user_pool.intake.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [var.intake_callback_url]
  logout_urls                          = ["${trimsuffix(var.intake_callback_url, "/")}/signed-out"]
  prevent_user_existence_errors        = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "intake" {
  domain       = local.intake_resource_name
  user_pool_id = aws_cognito_user_pool.intake.id
}
