#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROM_IMAGE="${PROM_IMAGE:-prom/prometheus:v2.54.1}"

log() {
  echo "[validate-prometheus] $*"
}

if ! command -v docker >/dev/null 2>&1; then
  log "docker no encontrado en PATH"
  exit 1
fi

log "validando reglas Prometheus con promtool"
docker run --rm \
  -v "$PWD/ops/prometheus:/rules:ro" \
  "$PROM_IMAGE" \
  promtool check rules /rules/recording.rules.yml /rules/alerts.rules.yml

log "validando config Prometheus (local/example)"
docker run --rm \
  -v "$PWD/ops/prometheus:/rules:ro" \
  "$PROM_IMAGE" \
  promtool check config /rules/prometheus.local.yml

docker run --rm \
  -v "$PWD/ops/prometheus:/rules:ro" \
  "$PROM_IMAGE" \
  promtool check config /rules/prometheus.example.yml

log "ok: reglas y configuraciones validas"
