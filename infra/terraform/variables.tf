variable "intake_name" {
  type        = string
  description = "Globally unique lowercase name for intake resources and the Cognito domain."
}

variable "intake_callback_url" {
  type        = string
  description = "Public HTTPS origin with a trailing slash, or http://localhost:3000/ for local development."
}
