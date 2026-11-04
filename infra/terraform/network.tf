# Uses the account's default VPC in us-west-2. No NAT gateway, no new VPC.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# App host: no inbound rules. Access via SSM Session Manager only. Outbound HTTPS, plus HTTP
# because Ubuntu's apt mirrors use port 80. See docs/decisions.md.
resource "aws_security_group" "app_host" {
  name        = "cht-nocode-app-host"
  description = "App host: no inbound; outbound HTTPS only; SSM access only"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "HTTPS only"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "HTTP for apt mirrors"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "cht-nocode-app-host"
  }
}

# CHT host: same shape. No inbound; outbound HTTPS only; SSM access only.
resource "aws_security_group" "cht_host" {
  name        = "cht-nocode-cht-host"
  description = "CHT host: no inbound; outbound HTTPS only; SSM access only"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "HTTPS only"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "cht-nocode-cht-host"
  }
}
