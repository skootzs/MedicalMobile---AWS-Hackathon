# Single-table design. On-demand, encrypted at rest, stream enabled for the
# outbox/events Pipes (section 8).
#
# Key layout (R2's domain; R7 only owns the table shape):
#   REQ#<requestId>   META | REV#000003 | APPROVAL#<id> | AUDIT#<ts>#<eventId>
#   JOB#<jobId>       META | RECEIPT#<msgId> | OUTBOX
#   SNAP#<hash>       META   (pointer to S3 URI + hash)
#
# GSI1 (gsi1pk/gsi1sk): jobs per request   -> REQ#<requestId> / JOB#<createdAt>
# GSI2 (gsi2pk/gsi2sk): reviewer inboxes   -> INBOX#<role>     / <createdAt>

resource "aws_dynamodb_table" "main" {
  name         = "cht-nocode"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "GSI2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  server_side_encryption {
    enabled = true
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  tags = {
    Name = "cht-nocode"
  }
}
