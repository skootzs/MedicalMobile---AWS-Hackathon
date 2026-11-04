#!/usr/bin/env bash
# App host bootstrap (Ubuntu 22.04 x86_64). Rendered by Terraform via templatefile().
# Installs Docker + Compose v2, Node >= 22.18, git, AWS CLI, writes TF outputs to
# /etc/cht-nocode/env, and installs the worker systemd services.
#
# shellcheck disable=SC2154 # ${aws_region} etc. below are Terraform templatefile() interpolations, not shell vars
# shellcheck disable=SC1091 # /etc/os-release is sourced at boot time on the target host, not available to shellcheck
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg git unzip

# Docker + Compose v2
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

# Node >= 22.18 (R5's compiler requirement)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version

# AWS CLI v2 (x86_64)
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws

# Terraform outputs, written for the worker services to source.
mkdir -p /etc/cht-nocode
cat > /etc/cht-nocode/env <<EOF
AWS_REGION=${aws_region}
PROJECT_TAG=cht-nocode
ARTIFACT_BUCKET=${artifact_bucket}
DDB_TABLE=${ddb_table}
JOBS_QUEUE_URL=${jobs_queue_url}
JOBS_DLQ_URL=${jobs_dlq_url}
COGNITO_USER_POOL_ID=${user_pool_id}
COGNITO_CLIENT_ID=${user_pool_client_id}
JOB_EVENTS_QUEUE_URL=${job_events_queue}
JOB_EVENTS_DLQ_URL=${job_events_dlq}
CHT_SECRET_NAME=${cht_secret_name}
BEDROCK_GUARDRAIL_ID=${guardrail_id}
BEDROCK_GUARDRAIL_VERSION=${guardrail_version}
MODE=aws
EOF
chmod 0640 /etc/cht-nocode/env

# Install the build runner from the newest image in ECR. On a brand-new deploy nothing has
# been pushed yet, so this boot skips it and scripts/kiro/31-deploy-runner.sh installs it.
tag="$(aws ecr describe-images --region "${aws_region}" --repository-name cht-nocode/worker \
  --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]' --output text 2>/dev/null || echo None)"
if [ "$tag" != "None" ] && [ -n "$tag" ]; then
  worker_image="${worker_repo_url}:$tag"
  aws ecr get-login-password --region "${aws_region}" \
    | docker login --username AWS --password-stdin "$(echo "${worker_repo_url}" | cut -d/ -f1)"
  docker pull "$worker_image"
  container="$(docker create "$worker_image")"
  docker cp "$container:/opt/cht-nocode-bundle/install-runner.sh" /tmp/install-runner.sh
  docker rm "$container"
  sh /tmp/install-runner.sh "$worker_image" "${build_repo_url}:$tag"
else
  echo "No runner image in ECR yet; skipping runner install"
fi
