# x86_64 only: the cht-app-ide build image is amd64-only (hard constraint).

data "aws_ami" "ubuntu_amd64" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_instance" "app_host" {
  ami                    = data.aws_ami.ubuntu_amd64.id
  instance_type          = var.app_host_instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.app_host.id]
  iam_instance_profile   = aws_iam_instance_profile.app_host.name

  # IMDSv2 required, hop limit 2.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  user_data = base64encode(templatefile("${path.module}/bootstrap/app-host.sh", {
    aws_region          = var.aws_region
    artifact_bucket     = aws_s3_bucket.artifacts.bucket
    ddb_table           = aws_dynamodb_table.main.name
    jobs_queue_url      = aws_sqs_queue.jobs.url
    jobs_dlq_url        = aws_sqs_queue.jobs_dlq.url
    user_pool_id        = aws_cognito_user_pool.main.id
    user_pool_client_id = aws_cognito_user_pool_client.main.id
  }))

  tags = {
    Name = "cht-nocode-app-host"
  }
}

resource "aws_instance" "cht_host" {
  ami                    = data.aws_ami.ubuntu_amd64.id
  instance_type          = var.cht_host_instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.cht_host.id]
  iam_instance_profile   = aws_iam_instance_profile.cht_host.name

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  user_data = filebase64("${path.module}/bootstrap/cht-host.sh")

  tags = {
    Name = "cht-nocode-cht-host"
  }
}
