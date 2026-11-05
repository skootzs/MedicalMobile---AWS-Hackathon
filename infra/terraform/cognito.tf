resource "aws_cognito_user_pool" "main" {
  name = "cht-nocode"

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  tags = {
    Name = "cht-nocode"
  }
}

resource "aws_cognito_user_pool_client" "main" {
  name         = "cht-nocode-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = ["http://localhost:8080"]
  logout_urls   = ["http://localhost:8080", "http://localhost:8080/signed-out"]

  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  prevent_user_existence_errors = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "cht-nocode-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}

locals {
  cognito_groups = ["po", "service_designer", "clinician", "developer", "release_approver"]
}

resource "aws_cognito_user_group" "groups" {
  for_each     = toset(local.cognito_groups)
  name         = each.value
  user_pool_id = aws_cognito_user_pool.main.id
}
