#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: docker-logs-safe.sh <aichattg-container-name> [--follow]

Finite reads are limited to 200 lines from the last 10 minutes and 20 seconds.
Follow reads are limited to 100 initial lines from the last 10 minutes and 5 minutes.
EOF
  exit 64
}

[[ $# -eq 1 || $# -eq 2 ]] || usage

container_name=$1
follow_mode=${2:-}

[[ $container_name =~ ^aichattg-[A-Za-z0-9_.-]*$ ]] || {
  echo 'container name must start with aichattg- and contain only letters, digits, dot, underscore, or hyphen' >&2
  exit 64
}

[[ -z $follow_mode || $follow_mode == '--follow' ]] || usage

command -v timeout >/dev/null 2>&1 || {
  echo 'GNU timeout is required for safe Docker-log diagnostics' >&2
  exit 69
}
command -v docker >/dev/null 2>&1 || {
  echo 'docker CLI is required for safe Docker-log diagnostics' >&2
  exit 69
}

if [[ $follow_mode == '--follow' ]]; then
  timeout_duration=5m
  tail_lines=100
  docker_args=(logs --follow --tail "$tail_lines" --since 10m "$container_name")
else
  timeout_duration=20s
  tail_lines=200
  docker_args=(logs --tail "$tail_lines" --since 10m "$container_name")
fi

set +e
timeout --signal=TERM --kill-after=5s "$timeout_duration" docker "${docker_args[@]}"
status=$?
set -e

if [[ $status -eq 124 ]]; then
  echo "docker log reader timed out after $timeout_duration for $container_name; record the incident and do not retry in a loop" >&2
fi

exit "$status"
