import { defaultProvider } from '@aws-sdk/credential-provider-node'

// A local AWS login can create or update profile files after the server starts.
// Keep the standard provider chain and successful credential refresh behavior,
// but reload those files whenever the chain needs to resolve credentials.
export const awsCredentials = defaultProvider({ ignoreCache: true })

export const credentialsUnavailableMessage =
  'The server cannot load AWS credentials. Sign in to AWS for the server’s configured profile, then click Sign in with Cognito again. If you changed AWS_PROFILE or other environment variables, restart the server first.'
