#!/bin/sh
# Runs as root on the app host. Installs the runner from a bundle image and starts it.
# Safe to re-run. Environment comes from /etc/cht-nocode/env (written by app-host.sh) and
# /etc/cht-nocode/runner.env (written here).
#
# Usage: install-runner.sh <worker-image> <build-image>
set -eu

[ "$#" -eq 2 ] || { echo "Usage: $0 <worker-image> <build-image>" >&2; exit 2; }
WORKER_IMAGE="$1"
BUILD_IMAGE="$2"
TAG="${WORKER_IMAGE##*:}"
ROOT="/opt/cht-nocode"
RELEASE="$ROOT/releases/$TAG"
WORK_DIR="/var/lib/cht-nocode/work"
COMPILE_IMAGE="node:22.23.4-slim"
LOG_FILE="/var/log/cht-nocode/runner.log"
AGENT_CTL="/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"

node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
  || { echo "Node >= 22.18 is required, found $(node --version)" >&2; exit 1; }

docker pull "$WORKER_IMAGE"
docker pull "$BUILD_IMAGE"
docker pull "$COMPILE_IMAGE"

mkdir -p "$ROOT/releases"
rm -rf "$RELEASE"
container="$(docker create "$WORKER_IMAGE")"
trap 'docker rm "$container" >/dev/null 2>&1 || true' EXIT
docker cp "$container:/opt/cht-nocode-bundle" "$RELEASE"
# The stage containers run as uid 1000 and mount these read-only.
chmod -R a+rX "$ROOT"

# shellcheck disable=SC1091 # written into the bundle by scripts/build-runner-image.sh
. "$RELEASE/versions.env"

cat > /etc/cht-nocode/runner.env <<ENV
WORKER_ID=cht-runner
COMPILE_IMAGE=$COMPILE_IMAGE
BUILD_IMAGE=$BUILD_IMAGE
COMPILER_DIR=$RELEASE/compiler
COMPILER_COMMIT=$COMPILER_COMMIT
TEMPLATE_DIR=$RELEASE/template
VERIFIER_DIR=$RELEASE/verifier
VERIFIER_COMMIT=$VERIFIER_COMMIT
RUNNER_WORK_DIR=$WORK_DIR
ENV
chmod 0640 /etc/cht-nocode/runner.env

mkdir -p "$WORK_DIR"
chown -R ubuntu:ubuntu /var/lib/cht-nocode

# Ship the runner's log to the group the error alarm watches.
if [ ! -x "$AGENT_CTL" ]; then
  curl -fsSL https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -o /tmp/amazon-cloudwatch-agent.deb
  dpkg -i -E /tmp/amazon-cloudwatch-agent.deb
  rm -f /tmp/amazon-cloudwatch-agent.deb
fi
mkdir -p "$(dirname "$LOG_FILE")"
cat > /opt/aws/amazon-cloudwatch-agent/etc/cht-nocode-runner.json <<JSON
{
  "agent": { "run_as_user": "root" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "$LOG_FILE",
            "log_group_name": "/cht-nocode/app",
            "log_stream_name": "runner-{instance_id}"
          }
        ]
      }
    }
  }
}
JSON
"$AGENT_CTL" -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/cht-nocode-runner.json
cat > /etc/logrotate.d/cht-nocode-runner <<ROTATE
$LOG_FILE {
  size 50M
  rotate 3
  compress
  missingok
  notifempty
  copytruncate
}
ROTATE

ln -sfn "$RELEASE" "$ROOT/current"
cp "$RELEASE/runner/cht-build-runner.service" /etc/systemd/system/cht-build-runner.service
systemctl daemon-reload
systemctl enable cht-build-runner
systemctl stop cht-build-runner || true
# Earlier lines are already shipped, and starting fresh lets a deploy check this run's log.
: > "$LOG_FILE"
systemctl start cht-build-runner

# Only the running release is needed. An unfinished job is taken over after its lease.
find "$ROOT/releases" -mindepth 1 -maxdepth 1 ! -name "$TAG" -exec rm -rf {} +
echo "Installed runner $TAG"
