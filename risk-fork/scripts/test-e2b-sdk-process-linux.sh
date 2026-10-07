#!/usr/bin/env bash
# Provider-free synthetic SDK boundary tests, NOT live E2B qualification.
set -euo pipefail
umask 077
source_root=$(realpath -- "${1:?absolute public source worktree required}")
[[ "$source_root" != / && -f "$source_root/risk-fork/scripts/verify-e2b-sdk-process.mjs" ]]
image='sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2'
docker image inspect "$image" >/dev/null
test -f "$source_root/risk-fork-hosted-mcp/dist/runtime/index.mjs"
lab=$(mktemp -d /tmp/risk-fork-sdk-process.XXXXXXXX)
lab=$(realpath -- "$lab")
[[ "$lab" =~ ^/tmp/risk-fork-sdk-process\.[A-Za-z0-9]{8}$ ]]
lab_id=$(basename -- "$lab")
label="agoragentic.risk-fork.sdk-process-lab=$lab_id"
prepare="${lab_id}-prepare"
verify="${lab_id}-verify"
cleanup() {
  original=$?
  trap - EXIT INT TERM
  cleanup_ok=true
  for name in "$prepare" "$verify" "${lab_id}-tree"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      actual=$(docker inspect --format '{{index .Config.Labels "agoragentic.risk-fork.sdk-process-lab"}}' "$name")
      if [[ "$actual" == "$lab_id" ]]; then docker rm -f "$name" >/dev/null || cleanup_ok=false; else cleanup_ok=false; fi
    fi
  done
  [[ -z "$(docker ps -aq --filter "label=$label")" ]] || cleanup_ok=false
  if [[ "$(realpath -- "$lab")" == "$lab" && "$lab" =~ ^/tmp/risk-fork-sdk-process\.[A-Za-z0-9]{8}$ ]]; then
    rm -rf -- "$lab" || cleanup_ok=false
  else cleanup_ok=false; fi
  printf '{"lab":"%s","lab_resources_cleanup_verified":%s,"original_exit_code":%s,"provider_calls":0,"provider_billing_observed":false,"production_qualified":false}\n' "$lab_id" "$cleanup_ok" "$original"
  [[ "$cleanup_ok" == true ]] || exit 90
  exit "$original"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$lab/fixtures"
chmod 755 "$lab" "$lab/fixtures"
docker run --rm --pull never --name "$prepare" --label "$label" --network none \
  --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --pids-limit 128 \
  --mount "type=bind,src=$source_root,dst=/source,readonly" \
  --mount "type=bind,src=$lab/fixtures,dst=/fixtures" \
  "$image" node /source/risk-fork/scripts/verify-e2b-sdk-process.mjs --prepare /fixtures
chmod -R a+rX "$lab/fixtures"
timeout --signal=TERM --kill-after=10s 120s docker run --rm --pull never \
  --name "$verify" --label "$label" --network none --user 65532:65532 \
  --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 1g --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --mount "type=bind,src=$source_root,dst=/source,readonly" \
  --mount "type=bind,src=$lab/fixtures,dst=/fixtures,readonly" \
  --mount "type=bind,src=$lab/fixtures/writable-dependency/node_modules/synthetic-sdk-dependency,dst=/fixtures/writable-dependency/node_modules/synthetic-sdk-dependency" \
  "$image" node /source/risk-fork/scripts/verify-e2b-sdk-process.mjs --verify /fixtures /source/risk-fork-hosted-mcp/dist/runtime/index.mjs
# Privilege-separated HOST observer. No --pid=host observer container, socket
# mount, provider key, image pull or network. It independently observes the
# real cgroup and detached PID incarnations, then tears down only its exact ID.
timeout --signal=TERM --kill-after=10s 90s node \
  "$source_root/risk-fork/scripts/verify-e2b-sdk-tree-observer.mjs" "$source_root" "$lab/fixtures"
timeout --signal=TERM --kill-after=10s 90s node \
  "$source_root/risk-fork/scripts/verify-e2b-sdk-tree-observer.mjs" "$source_root" "$lab/fixtures" cancel_before_handoff
