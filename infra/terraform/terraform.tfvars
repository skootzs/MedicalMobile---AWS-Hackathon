intake_name         = "medic-mobile-cht-intake-dev-7f4a2c"
intake_callback_url = "http://localhost:3000/"

intake_screening_enabled = true

intake_bedrock_model_id = "us.openai.gpt-5.6-sol"

intake_bedrock_model_arns = [
  "arn:aws:bedrock:us-west-2:598545683572:inference-profile/us.openai.gpt-5.6-sol",
  "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-5.6-sol",
  "arn:aws:bedrock:us-east-2::foundation-model/openai.gpt-5.6-sol",
  "arn:aws:bedrock:us-west-2::foundation-model/openai.gpt-5.6-sol",
  "arn:aws:bedrock:us-west-2:598545683572:project/default"
]