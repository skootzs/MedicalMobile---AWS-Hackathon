#!/usr/bin/env bash
# Diagnoses the verify-stage Chromium crash (ChrootToSafeEmptyDir, zygote signal 6) by
# starting the real harness under different container flags. Only runs throwaway
# containers, and changes no runner flags: choosing a variant is Srithan's decision.
#
#   a  current stage 6 flags: --cap-drop ALL --cap-add SYS_ADMIN
#   b  a + SYS_CHROOT, SETUID, SETGID
#   c  Docker's default caps + SYS_ADMIN
#   d  --cap-drop ALL, with Chromium launched with --no-sandbox via the harness options
#   e  a + seccomp=unconfined (diagnostic only, not a candidate fix)
#
# RESULT: PASS means the matrix ran and at least one of a-d works.
set -euo pipefail

IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
PROBE_TIMEOUT_SECONDS="${PROBE_TIMEOUT_SECONDS:-180}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR" 2>/dev/null || true' EXIT

docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 \
  || { echo "RESULT: FAIL $IMAGE_TAG not found, run 20-build-image.sh first"; exit 1; }

# start() launches Chromium and loads the form host in a renderer, which is where the
# sandbox crash happens. The harness only needs an app_settings.json to get that far.
mkdir "$WORK_DIR/project" "$WORK_DIR/probe"
echo '{}' > "$WORK_DIR/project/app_settings.json"
cat > "$WORK_DIR/probe/probe.cjs" <<'EOF'
const Harness = require('cht-conf-test-harness');
const options = { directory: '/project', headless: true };
if (process.env.PROBE_NO_SANDBOX === '1') options.args = ['--no-sandbox'];
(async () => {
  const harness = new Harness(options);
  await harness.start();
  console.log(`PROBE_OK ${await harness.browser.version()}`);
  await harness.stop();
})().catch((err) => {
  console.error(`PROBE_FAIL ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
EOF
chmod -R a+rX "$WORK_DIR"

echo "== 27-chromium-sandbox-matrix: host context =="
uname -r
docker info --format 'docker {{.ServerVersion}}, security options: {{.SecurityOptions}}'
for key in user.max_user_namespaces kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns; do
  echo "$key = $(sysctl -n "$key" 2>/dev/null || echo 'not present')"
done

names=()
results=()

# Usage: run_variant <name> <no-sandbox 0|1> <docker flags...>
run_variant() {
  local name="$1" no_sandbox="$2"
  shift 2
  local log="$WORK_DIR/variant-$name.log" result
  echo
  echo "== variant $name: $* (no-sandbox=$no_sandbox) =="
  # Keep the matrix going when a variant fails: that's the data this script collects.
  timeout "$PROBE_TIMEOUT_SECONDS" docker run --rm --platform linux/amd64 --network none --read-only \
    --tmpfs /tmp --user 1000:1000 "$@" \
    -e TZ=Africa/Nairobi -e npm_config_cache=/tmp/npm -e NODE_PATH=/build-image/node_modules \
    -e "PROBE_NO_SANDBOX=$no_sandbox" \
    -v "$WORK_DIR/project:/project:ro" -v "$WORK_DIR/probe:/probe:ro" \
    "$IMAGE_TAG" node /probe/probe.cjs > "$log" 2>&1 || true
  if grep -q '^PROBE_OK' "$log"; then
    result=PASS
    grep '^PROBE_OK' "$log"
  else
    result=FAIL
    tail -n 15 "$log"
  fi
  names+=("$name")
  results+=("$result")
}

run_variant a 0 --cap-drop ALL --cap-add SYS_ADMIN
run_variant b 0 --cap-drop ALL --cap-add SYS_ADMIN --cap-add SYS_CHROOT --cap-add SETUID --cap-add SETGID
run_variant c 0 --cap-add SYS_ADMIN
run_variant d 1 --cap-drop ALL
run_variant e 0 --cap-drop ALL --cap-add SYS_ADMIN --security-opt seccomp=unconfined

echo
echo "== 27-chromium-sandbox-matrix: results =="
printf '%-8s %-6s %s\n' VARIANT RESULT FLAGS
describe() {
  case "$1" in
    a) echo 'cap-drop ALL + SYS_ADMIN (current)' ;;
    b) echo 'a + SYS_CHROOT, SETUID, SETGID' ;;
    c) echo 'default caps + SYS_ADMIN' ;;
    d) echo 'cap-drop ALL, Chromium --no-sandbox' ;;
    e) echo 'a + seccomp=unconfined (diagnostic only)' ;;
  esac
}
usable=no
for i in "${!names[@]}"; do
  printf '%-8s %-6s %s\n' "${names[$i]}" "${results[$i]}" "$(describe "${names[$i]}")"
  if [ "${names[$i]}" != e ] && [ "${results[$i]}" = PASS ]; then usable=yes; fi
done

if [ "$usable" = yes ]; then
  echo "RESULT: PASS matrix finished, send the table above to Srithan to choose a variant"
else
  echo "RESULT: FAIL none of variants a-d started the harness, see the logs above"
  exit 1
fi
