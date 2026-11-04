provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project = "cht-nocode"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}
