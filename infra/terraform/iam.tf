# Least privilege. No long-lived access keys anywhere; IAM roles only.

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# ---------- CHT host: SSM only ----------

resource "aws_iam_role" "cht_host" {
  name               = "cht-nocode-cht-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

resource "aws_iam_role_policy_attachment" "cht_host_ssm" {
  role       = aws_iam_role.cht_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "cht_host" {
  name = "cht-nocode-cht-host"
  role = aws_iam_role.cht_host.name
}

# ---------- App host ----------

resource "aws_iam_role" "app_host" {
  name               = "cht-nocode-app-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

resource "aws_iam_role_policy_attachment" "app_host_ssm" {
  role       = aws_iam_role.app_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app_host" {
  # S3: read/write on the artifact bucket only, no DeleteObject, PutObject
  # restricted to the known prefixes.
  statement {
    sid       = "S3ReadBucket"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
  }

  statement {
    sid     = "S3PutByPrefix"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/snapshots/*",
      "${aws_s3_bucket.artifacts.arn}/builds/*",
      "${aws_s3_bucket.artifacts.arn}/previews/*",
      "${aws_s3_bucket.artifacts.arn}/sources/*",
    ]
  }

  # DynamoDB: no DeleteItem.
  statement {
    sid = "DynamoDBTableAndIndexes"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [
      aws_dynamodb_table.main.arn,
      "${aws_dynamodb_table.main.arn}/index/*",
    ]
  }

  statement {
    sid = "SQSJobsQueues"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.jobs.arn, aws_sqs_queue.jobs_dlq.arn]
  }

  statement {
    sid       = "SecretsReadOnly"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.cht_login.arn]
  }

  statement {
    sid       = "ECRPull"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ECRPullRepos"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = [for r in aws_ecr_repository.repos : r.arn]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }

  # Bedrock: Claude `us.` inference profiles + Nova foundation models, us-west-2 only.
  statement {
    sid     = "BedrockInvoke"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:us-west-2:*:inference-profile/us.anthropic.*",
      "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-*",
    ]
  }

  # Cognito: read-only.
  statement {
    sid       = "CognitoReadOnly"
    actions   = ["cognito-idp:ListUsers", "cognito-idp:AdminGetUser"]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

resource "aws_iam_role_policy" "app_host" {
  name   = "cht-nocode-app-host-policy"
  role   = aws_iam_role.app_host.id
  policy = data.aws_iam_policy_document.app_host.json
}

resource "aws_iam_instance_profile" "app_host" {
  name = "cht-nocode-app-host"
  role = aws_iam_role.app_host.name
}
