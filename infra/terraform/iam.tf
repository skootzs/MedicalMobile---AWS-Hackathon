resource "aws_iam_policy" "intake_runtime" {
  name = "${var.intake_name}-runtime"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
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
    ]
  })
}

output "intake_runtime_policy_arn" {
  value = aws_iam_policy.intake_runtime.arn
}
