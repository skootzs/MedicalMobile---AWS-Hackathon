variable "aws_region" {
  description = "AWS region. Hard constraint: us-west-2 only."
  type        = string
  default     = "us-west-2"
}

variable "app_host_instance_type" {
  description = "Instance type for the app host (orchestrator + workers)."
  type        = string
  default     = "t3.large"
}

variable "cht_host_instance_type" {
  description = "Instance type for the CHT reference-app host."
  type        = string
  default     = "t3.large"
}

variable "bedrock_draft_model_id" {
  # TODO: confirm exact inference-profile ID with the team before apply; must be a Claude `us.` profile or Nova.
  description = "Bedrock model ID for drafting. Claude us. inference profile or Nova only."
  type        = string
  default     = "TODO-confirm-bedrock-model-id"
}

variable "bedrock_fast_model_id" {
  # TODO: confirm exact inference-profile ID with the team before apply. Budget rule: develop against Haiku/fixtures, not Opus.
  description = "Bedrock model ID for fast/cheap calls (triage, routing hints)."
  type        = string
  default     = "TODO-confirm-bedrock-model-id"
}

variable "bedrock_crosscheck_model_id" {
  # TODO: confirm exact inference-profile ID with the team before apply.
  description = "Bedrock model ID for cross-check / spec review."
  type        = string
  default     = "TODO-confirm-bedrock-model-id"
}

variable "alarm_email" {
  description = "Email address for the error-rate CloudWatch alarm. Set it with TF_VAR_alarm_email."
  type        = string
}

variable "lease_seconds" {
  description = "Job lease duration for the compile/verify runner."
  type        = number
  default     = 900
}

variable "build_timeout_seconds" {
  description = "Timeout for a single build stage (compile or verify)."
  type        = number
  default     = 600
}

variable "stop_schedule_timezone" {
  description = "Timezone for the nightly instance-stop schedule."
  type        = string
  default     = "America/Los_Angeles"
}

variable "intake_name" {
  description = "Optional name for the intake table, bucket, and Cognito domain. Empty uses cht-nocode-intake plus the account id."
  type        = string
  default     = ""
}

variable "intake_callback_url" {
  description = "Intake sign-in callback. Local default is the intake server origin."
  type        = string
  default     = "http://localhost:3000/"
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size (GB) for both hosts."
  type        = number
  default     = 30
}
