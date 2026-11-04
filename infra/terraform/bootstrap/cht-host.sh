#!/usr/bin/env bash
# CHT host bootstrap (Ubuntu 22.04 x86_64).
# Installs Docker + Compose v2 and downloads the CHT Docker Helper into ~/cht-hackathon.
#
# shellcheck disable=SC1091 # /etc/os-release is sourced at boot time on the target host, not available to shellcheck
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg git

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

HOME_DIR="/home/ubuntu"
mkdir -p "$HOME_DIR/cht-hackathon"
cd "$HOME_DIR/cht-hackathon"

# TODO(R7): confirm the exact Docker Helper repo/script path with R6/R1 once the
# CHT reference deploy is finalized (scripts/setup-cht.sh does the actual deploy).
git clone --depth 1 https://github.com/medic/cht-core.git cht-core || true

chown -R ubuntu:ubuntu "$HOME_DIR/cht-hackathon"
