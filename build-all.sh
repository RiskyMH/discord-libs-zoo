#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root_dir"

mapfile -t dockerfiles < <(find . -type f -iname 'dockerfile' -not -path './.git/*' -not -path '*/node_modules/*' -not -path '*/_deps/*' -not -path '*/vendor/*')
mapfile -t dirs < <(printf '%s\n' "${dockerfiles[@]}" | xargs -I{} dirname {} | sort -u)

if [[ ${#dirs[@]} -eq 0 ]]; then
  echo "No Dockerfiles found." >&2
  exit 1
fi

echo "Building ${#dirs[@]} image(s) in parallel:"
printf '  - %s\n' "${dirs[@]}"

log_dir="$(mktemp -d)"
pids=()

build_dir() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  local tag="discord-libs-zoo/${name}:latest"
  local log="${log_dir}/${name}.log"

  if docker build --progress=plain -t "$tag" "$dir" >"$log" 2>&1; then
    echo "[ok] ${name} -> ${tag}"
  else
    echo "[FAILED] ${name} (log: ${log})" >&2
    return 1
  fi
}

for dir in "${dirs[@]}"; do
  build_dir "$dir" &
  pids+=("$!")
done

fail=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    fail=1
  fi
done

echo
if [[ $fail -eq 0 ]]; then
  echo "All builds succeeded."
else
  echo "One or more builds failed. Check the logs in: ${log_dir}"
fi

exit "$fail"
