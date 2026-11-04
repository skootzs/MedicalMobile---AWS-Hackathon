locals {
  ecr_repo_names = ["build-image", "orchestrator", "ui", "worker"]
}

resource "aws_ecr_repository" "repos" {
  for_each             = toset(local.ecr_repo_names)
  name                 = "cht-nocode/${each.value}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "cht-nocode-${each.value}"
  }
}

resource "aws_ecr_lifecycle_policy" "repos" {
  for_each   = aws_ecr_repository.repos
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
