# Bedrock Guardrail: blocks/anonymizes PII on model inputs. Applies to every
# Bedrock call the app host role makes (draft, routing-hint, cross-check).

resource "aws_bedrock_guardrail" "pii" {
  name                      = "cht-nocode-pii-guardrail"
  description               = "Blocks/anonymizes PII on inputs: names, phone, email, address, government IDs."
  blocked_input_messaging   = "This request was blocked because it may contain personal information. Remove personal identifiers and try again."
  blocked_outputs_messaging = "This response was blocked because it may contain personal information."

  sensitive_information_policy_config {
    pii_entities_config {
      type   = "NAME"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "PHONE"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "EMAIL"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "ADDRESS"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "US_SOCIAL_SECURITY_NUMBER"
      action = "BLOCK"
    }
    pii_entities_config {
      type   = "US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER"
      action = "BLOCK"
    }
    pii_entities_config {
      type   = "DRIVER_ID"
      action = "BLOCK"
    }
  }

  tags = {
    Name    = "cht-nocode-pii-guardrail"
    project = "cht-nocode"
  }
}

# Guardrails are versioned explicitly; a numbered version pins the config
# apply/invoke calls reference, separate from the mutable DRAFT.
resource "aws_bedrock_guardrail_version" "pii" {
  guardrail_arn = aws_bedrock_guardrail.pii.guardrail_arn
  description   = "Initial PII guardrail version."
}
