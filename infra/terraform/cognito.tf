resource "aws_cognito_user_pool" "intake" {
  name = var.intake_name

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

resource "aws_cognito_user_pool_client" "intake" {
  name                                 = var.intake_name
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
  domain       = var.intake_name
  user_pool_id = aws_cognito_user_pool.intake.id
}
