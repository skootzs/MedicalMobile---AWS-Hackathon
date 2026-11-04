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
MODE=aws
EOF
chmod 0640 /etc/cht-nocode/env

# TODO(R7): install/enable the compile-worker systemd unit once runner/ ships a
# packaged build (section 7). Placeholder directory so the unit file has a home.
mkdir -p /opt/cht-nocode/runner
