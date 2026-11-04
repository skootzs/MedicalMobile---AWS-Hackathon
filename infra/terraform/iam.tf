resource "aws_iam_policy" "intake_runtime" {
  name = "${var.intake_name}-runtime"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
        Resource = aws_dynamodb_table.intake.arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.intake.arn
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = ["author#*", "requests#*"]
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.intake.arn}/intake/*"
      }
      ], var.intake_screening_enabled ? [
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = var.intake_bedrock_model_arns
        Condition = {
          StringEquals = {
            "bedrock:GuardrailIdentifier" = "${aws_bedrock_guardrail.intake[0].guardrail_arn}:${aws_bedrock_guardrail_version.intake[0].version}"
          }
        }
      }
      ] : [], var.intake_screening_enabled ? [
      {
        Effect   = "Allow"
        Action   = ["bedrock:ApplyGuardrail"]
        Resource = aws_bedrock_guardrail.intake[0].guardrail_arn
      }
    ] : [])
  })
}

output "intake_runtime_policy_arn" {
  value = aws_iam_policy.intake_runtime.arn
}
