#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
compose_file="$repo_root/infra/aichattg/docker-compose.yml"

[[ -f "$compose_file" ]] || { echo "missing Compose file: $compose_file" >&2; exit 1; }

required=(
  'aichattg-gatekeeper'
  'aichattg-telegram-runtime'
  'AICHATTG_FQDN'
  'AICHATTG_DATA_ROOT'
  'AICHATTG_GATEKEEPER_ROUTING_ENABLED'
  'AICHATTG_RUNTIME_ROUTING_ENABLED'
  'root_default'
)
for marker in "${required[@]}"; do
  rg -F --quiet "$marker" "$compose_file" || { echo "missing isolation marker: $marker" >&2; exit 1; }
done

for forbidden in 'news-digest' '/srv/news_agent_001' 'news.questtales.com'; do
  if rg -F --quiet "$forbidden" "$compose_file"; then
    echo "forbidden News runtime reference: $forbidden" >&2
    exit 1
  fi
done

docker compose -f "$compose_file" config --no-interpolate >/dev/null
echo 'aichattg infrastructure isolation: passed'
