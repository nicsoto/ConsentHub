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
  --entrypoint promtool \
  -v "$PWD/ops/prometheus:/etc/prometheus:ro" \
  "$PROM_IMAGE" \
  check rules /etc/prometheus/recording.rules.yml /etc/prometheus/alerts.rules.yml

log "validando config Prometheus (local/example)"
docker run --rm \
  --entrypoint promtool \
  -v "$PWD/ops/prometheus:/etc/prometheus:ro" \
  "$PROM_IMAGE" \
  check config /etc/prometheus/prometheus.local.yml

docker run --rm \
  --entrypoint promtool \
  -v "$PWD/ops/prometheus:/etc/prometheus:ro" \
  "$PROM_IMAGE" \
  check config /etc/prometheus/prometheus.example.yml

log "ok: reglas y configuraciones validas"
