variable "intake_screening_enabled" {
  type    = bool
  default = true
}

variable "intake_bedrock_model_id" {
  type    = string
  default = ""
}

variable "intake_bedrock_model_arns" {
  description = "Exact model or profile ARN and any destination foundation model ARNs it requires."
  type        = list(string)
  default     = []
}

resource "aws_bedrock_guardrail" "intake" {
  count                     = var.intake_screening_enabled ? 1 : 0
  name                      = "${var.intake_name}-screening"
  blocked_input_messaging   = "Screening stopped. Use public or synthetic guideline evidence."
  blocked_outputs_messaging = "Screening could not return an acceptable result."
  content_policy_config {
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE"
    }
  }
  sensitive_information_policy_config {
    dynamic "pii_entities_config" {
      for_each = toset(["EMAIL", "PHONE", "NAME", "ADDRESS"])
      content {
        type   = pii_entities_config.value
        action = "BLOCK"
      }
    }
  }
  lifecycle {
    precondition {
      condition     = var.intake_bedrock_model_id != "" && length(var.intake_bedrock_model_arns) > 0 && !contains(var.intake_bedrock_model_arns, "*")
      error_message = "Enabled screening requires a model ID and explicit allowed model/profile ARNs."
    }
  }
}

resource "aws_bedrock_guardrail_version" "intake" {
  count         = var.intake_screening_enabled ? 1 : 0
  guardrail_arn = aws_bedrock_guardrail.intake[0].guardrail_arn
  description   = "Published intake screening policy"
  lifecycle {
    replace_triggered_by = [aws_bedrock_guardrail.intake[0]]
  }
}

output "intake_screening_environment" {
  value = merge({ INTAKE_SCREENING_ENABLED = tostring(var.intake_screening_enabled) }, var.intake_screening_enabled ? {
    BEDROCK_MODEL_ID          = var.intake_bedrock_model_id
    BEDROCK_GUARDRAIL_ID      = aws_bedrock_guardrail.intake[0].guardrail_id
    BEDROCK_GUARDRAIL_VERSION = aws_bedrock_guardrail_version.intake[0].version
  } : {})
}
