# Presenter AWS setup: one PO account

Use this handoff to run this repository locally against the existing AWS demo backend. You need **one Cognito user with a permanent password**, **one DynamoDB PO assignment**, and **AWS credentials for the local server**. PO means product owner here.

The normal path reuses the deployed resources. You do not need a new IAM user for the presenter’s application login, a Cognito group, EC2, or a new deployment.

## 1. Get the demo settings from the current owner

Ask for these values through the team’s usual handoff channel. Do not commit passwords, AWS credentials, or `.env` files.

| Setting | What to obtain |
| --- | --- |
| AWS account and Region | The account hosting the demo; the checked-in sandbox configuration targets `us-west-2`. Confirm the actual deployment. |
| AWS access | Your own AWS SSO/profile with the runtime policy attached, plus administrator access for the one-time user setup (or have the owner perform steps 3–4). |
| Cognito | User pool ID, app client ID, hosted sign-in domain. |
| Storage | Intake DynamoDB table name and private S3 bucket name. |
| Registry | The baseline registry JSON and the configuration artifact/version it describes. |
| Screening | Whether enabled; the deployed model/profile ID, guardrail ID, and published guardrail version. |

An owner with the correct Terraform state can retrieve the settings from the repo root:

```sh
rtk terraform -chdir=infra/terraform output -json intake_environment
rtk terraform -chdir=infra/terraform output -json intake_screening_environment
rtk terraform -chdir=infra/terraform output -raw intake_runtime_policy_arn
```

A fresh clone does not contain deployed Terraform state. If outputs are unavailable, obtain the values from the owner or the AWS console; do not apply Terraform just to discover an existing demo.

## 2. Prepare the laptop and server permissions

Install Node.js 22.13 or newer, npm, and AWS CLI v2. The command examples use the repository’s `rtk` wrapper; install it if needed. Run from the cloned repository root.

```sh
rtk node --version
rtk npm ci
rtk aws sso login --profile <your-demo-profile>
rtk aws sts get-caller-identity --profile <your-demo-profile> --region us-west-2
```

Use an already configured SSO profile, or configure it with the account owner’s SSO details first. Check that the returned AWS account is the intended demo account.

The owner should attach the policy returned by `intake_runtime_policy_arn` to the IAM role/permission set used by the local server. The policy in `infra/terraform/iam.tf` allows:

- DynamoDB reads of the intake table, including role assignments, and writes only under `author#*` and `requests#*` partitions.
- S3 reads and writes under the configured bucket’s `intake/*` prefix.
- When screening is enabled, invocation of the approved Bedrock resources with the configured published guardrail, and `bedrock:ApplyGuardrail`.

The server’s runtime policy intentionally cannot create `roles#*` assignments. The person provisioning the account needs separate, scoped administrator permissions for `cognito-idp:AdminCreateUser`, `cognito-idp:AdminSetUserPassword`, `cognito-idp:AdminGetUser`, and DynamoDB `PutItem`/`GetItem` on the intake table. Console use may also need list/describe permissions. Do not broaden the server’s policy to administer users.

## 3. Create one Cognito user and set its password

In the correct AWS account and Region, open **Amazon Cognito → User pools → the intake pool → Users → Create user**.

1. Choose a distinct username, for example `demo-presenter`. Follow any username/email requirements configured on this pool.
2. Suppress the invitation message if creating a username-only demo account; share the credentials privately.
3. Set an initial password that satisfies the pool’s password policy.
4. Set a **permanent** password using the command below so the presenter can sign in without a first-login password-change challenge. Replace the placeholders locally; never put the real password in this document or a committed script. The CLI argument can appear in shell history, so use a private session with history recording disabled for this operation.

```sh
rtk aws cognito-idp admin-set-user-password \
  --profile <setup-admin-profile> --region us-west-2 \
  --user-pool-id <pool-id> --username demo-presenter \
  --password '<chosen-password>' --permanent

rtk aws cognito-idp admin-get-user \
  --profile <setup-admin-profile> --region us-west-2 \
  --user-pool-id <pool-id> --username demo-presenter
```

Check `Enabled: true` and `UserStatus: CONFIRMED`. Copy the value of the `sub` entry in `UserAttributes` (also shown in the console user details). Use that exact UUID in the next step, **not the username, email, pool ID, or app client ID**.

CLI alternative to the console’s create-user action, before setting the permanent password:

```sh
rtk aws cognito-idp admin-create-user \
  --profile <setup-admin-profile> --region us-west-2 \
  --user-pool-id <pool-id> --username demo-presenter \
  --message-action SUPPRESS
```

If the username already exists, inspect that account rather than creating another. Confirm with the owner before resetting an existing person’s password.

## 4. Grant PO access in DynamoDB

Open **DynamoDB → Tables → the intake table → Explore table items → Create item**. In DynamoDB JSON mode, enter:

```json
{
  "pk": { "S": "roles#<cognito-sub>" },
  "sk": { "S": "assignment" },
  "roles": { "L": [{ "S": "PO" }] }
}
```

Replace `<cognito-sub>` with the UUID copied above. The attribute names and values are case-sensitive. `roles` must be a **List** containing the **String** `PO`; a string, string set, lowercase `po`, or Cognito group does not grant access in this application. In the console’s form editor, the equivalent is `pk` (String), `sk` (String), and `roles` (List) with one String element.

Alternatively, save that JSON as `po-role.json` outside the repository, then run:

```sh
rtk aws dynamodb put-item \
  --profile <setup-admin-profile> --region us-west-2 \
  --table-name <intake-table> --item file://po-role.json \
  --condition-expression 'attribute_not_exists(pk)'
```

The condition prevents replacing an existing assignment. If it fails, inspect the existing item and preserve any required roles when editing it. In the table, verify the saved key is exactly `roles#<sub>` / `assignment` and that `roles` contains `PO`.

## 5. Configure local startup

Create `.env` at the repository root using the values from step 1:

```dotenv
AWS_PROFILE=your-demo-profile
AWS_REGION=us-west-2
COGNITO_USER_POOL_ID=<pool-id>
COGNITO_CLIENT_ID=<app-client-id>
COGNITO_HOSTED_URL=https://<domain-prefix>.auth.us-west-2.amazoncognito.com
COGNITO_REDIRECT_URI=http://localhost:3000/
INTAKE_TABLE=<intake-table>
INTAKE_BUCKET=<intake-bucket>
INTAKE_REGISTRY=/absolute/path/to/config-registry.json
INTAKE_SCREENING_ENABLED=true
BEDROCK_MODEL_ID=<deployed-model-or-profile-id>
BEDROCK_GUARDRAIL_ID=<deployed-guardrail-id>
BEDROCK_GUARDRAIL_VERSION=<published-numeric-version>
HOST=127.0.0.1
PORT=3000
```

Use the actual hosted URL from the deployment, especially for a custom domain. The registry must map each selectable baseline version to the lowercase 64-character SHA-256 digest of its configuration artifact. Copy the owner’s registry and update its absolute path for your laptop. Do not hash the registry file itself or invent a digest.

In the Cognito app client’s login settings, verify:

- Authorization code grant enabled, scope `openid`, identity provider `COGNITO`, and no client secret (the app uses PKCE).
- Allowed callback URL: `http://localhost:3000/`.
- Allowed sign-out URL: `http://localhost:3000/signed-out`.

Use **localhost** consistently; `127.0.0.1` is a different callback URL. These URLs must agree with `.env`. Have the owner manage permanent URL changes through Terraform when applicable.

For screening, reuse the deployed model/profile and published guardrail settings. The AWS account must be able to invoke that model, and the runtime policy must include the profile and any required destination model resources. Do not copy another account’s model ARNs. A guardrail version of `DRAFT` is rejected.

If only demonstrating sign-in and submission, `INTAKE_SCREENING_ENABLED=false` disables screening. It does **not** support the full screening → preview → confirmation journey. Runtime screening defaults to disabled when the flag is omitted, whereas the Terraform screening variable currently defaults to enabled; set the flag explicitly.

```sh
rtk npm start
```

Open [http://localhost:3000/](http://localhost:3000/). There is no separate UI build or frontend server. Existing exported environment variables override `.env`; restart the server after changing settings or AWS profiles.

## 6. Rehearse the demo

1. Click **Sign in with Cognito** and use the new username and permanent password.
2. Open **Profile**. Verify the username, the same user ID used in DynamoDB, and the `PO` role.
3. Submit a request with all four requirements filled in: goal, pathway, target users, and acceptance criteria. Select a version from the supplied registry. Use synthetic/public content. An attachment is optional; request attachments accept UTF-8 TXT or Markdown up to 256 KiB.
4. Open the request and screen the revision. Resolve any clarification using a correction, screen again, create the preview, and confirm that exact revision.
5. Verify the queued handoff is shown. This repo’s intake implementation stops at the durable queue; it does not dispatch a downstream workflow or deploy a CHT configuration.
6. Log out, check the signed-out confirmation page, and sign in again before presenting.

A new PO account sees its own requests only. Existing requests belonging to another account will not appear. Create the presenter’s rehearsal request with this account if the demo needs history.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login works but the app says PO role required | Correct table/Region; `roles#` plus the user’s exact `sub`; `sk=assignment`; `roles` is a List containing `PO`. |
| Server cannot load AWS credentials | Run SSO login for the profile in `.env`, then retry sign-in with a fresh authorization code. Restart if changing profiles. Browser login does not authenticate the server to AWS. |
| Access denied / temporarily unavailable | Runtime IAM policy attached to the server’s actual identity; correct table and bucket. Check server error name and AWS account. |
| Cognito callback or logout error | Exact app client ID and registered URLs, including callback trailing slash, hostname, and port. |
| Password-change prompt | Permanent password was not set; check Cognito user status. |
| App fails at startup / baseline list empty | Registry exists at the absolute path, contains version-to-digest entries, and all required `.env` settings are populated. |
| Screening fails or is unavailable | Explicit enabled flag, model access, approved model/profile ARNs, published guardrail version, and matching Region. |

## Only if provisioning into a new AWS account

The existing-backend steps above are sufficient for a presenter. For a new deployment, an infrastructure owner must initialize `infra/terraform`, use a globally unique lowercase `intake_name`, set the callback URL, configure the intended AWS account/Region and that account’s Bedrock model/profile ARNs, review a Terraform plan, and apply it. The checked-in `terraform.tfvars` refers to a specific sandbox account and must not be reused unchanged in another account. Retrieve the resulting outputs, grant the runtime policy to the server role, supply a baseline registry, then follow steps 3–6. Terraform creates the pool/client/domain, table, bucket, runtime policy, and screening guardrail; it does not create the presenter user or its PO assignment.

## AWS references

- [AdminCreateUser](https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/admin-create-user.html): suppressing the invitation message.
- [AdminSetUserPassword](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminSetUserPassword.html): permanent passwords and user confirmation.
- [DynamoDB PutItem](https://docs.aws.amazon.com/cli/latest/reference/dynamodb/put-item.html): typed JSON and conditional creation.
