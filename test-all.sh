#!/usr/bin/env bash
set -euo pipefail

DURATION="${DURATION:-10}"

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root_dir"

mapfile -t dockerfiles < <(find . -type f -iname 'dockerfile' -not -path './.git/*' -not -path '*/node_modules/*' -not -path '*/_deps/*' -not -path '*/vendor/*')
mapfile -t dirs < <(printf '%s\n' "${dockerfiles[@]}" | xargs -I{} dirname {} | sort -u)

if [[ ${#dirs[@]} -eq 0 ]]; then
  echo "No Dockerfiles found." >&2
  exit 1
fi

env_flags=()
for var in ${TEST_ENV_VARS:-DISCORD_TOKEN DB_PATH}; do
  if [[ -n "${!var:-}" ]]; then
    env_flags+=(--env "$var")
  fi
done

echo "Testing ${#dirs[@]} image(s) for ${DURATION}s each, one at a time:"
printf '  - %s\n' "${dirs[@]}"
if [[ ${#env_flags[@]} -eq 0 ]]; then
  echo "  (no env vars forwarded; set DISCORD_TOKEN to actually connect)"
else
  echo "  (forwarding env vars: ${env_flags[*]})"
fi

log_dir="$(mktemp -d)"
fail=0

test_dir() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  local tag="discord-libs-zoo/${name}:latest"
  local container="zoo-test-${name}-$$"
  local log="${log_dir}/${name}.log"

  docker run --name "$container" "${env_flags[@]}" "$tag" >"$log" 2>&1 &

  local ready=false
  local i
  for i in $(seq 1 "$DURATION"); do
    sleep 1
    local status
    status="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)"
    if [[ -z "$status" ]]; then
      echo "[FAILED] ${name} container vanished (log: ${log})" >&2
      return 1
    fi
    if [[ "$status" != "running" && "$status" != "created" ]]; then
      local code
      code="$(docker inspect -f '{{.State.ExitCode}}' "$container" 2>/dev/null || echo '?')"
      echo "[FAILED] ${name} exited early after ${i}s with code ${code} (log: ${log})" >&2
      docker rm -f "$container" >/dev/null 2>&1 || true
      return 1
    fi
    if docker logs "$container" 2>&1 | grep -q "Logged in as"; then
      ready=true
    fi
  done

  docker kill "$container" >/dev/null 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [[ "$ready" != true ]]; then
    echo "[FAILED] ${name} stayed up ${DURATION}s but never logged 'Logged in as' (log: ${log})" >&2
    return 1
  fi
  echo "[ok] ${name} stayed up for ${DURATION}s and became ready"
}

for dir in "${dirs[@]}"; do
  if ! test_dir "$dir"; then
    fail=1
  fi
done

echo
if [[ $fail -eq 0 ]]; then
  echo "All tests passed."
else
  echo "One or more tests failed. Check the logs in: ${log_dir}"
fi

exit "$fail"
