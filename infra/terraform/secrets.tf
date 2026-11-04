# CHT login credential. Value is set manually (console/CLI) after apply -- never in Terraform.

resource "aws_secretsmanager_secret" "cht_login" {
  name        = "cht-nocode/cht-login"
  description = "CHT reference-app login. Value set manually, never via Terraform."

  tags = {
    Name = "cht-nocode-cht-login"
  }
}
