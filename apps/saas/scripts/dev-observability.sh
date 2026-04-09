#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROM_URL="${PROM_URL:-http://127.0.0.1:9090}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3000}"

log() {
  echo "[dev-observability] $*"
}

wait_http_ok() {
  local url="$1"
  local name="$2"
  local retries="${3:-60}"
  local delay_seconds="${4:-2}"

  for ((i=1; i<=retries; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$name listo en $url"
      return 0
    fi
    sleep "$delay_seconds"
  done

  log "timeout esperando $name en $url"
  return 1
}

if ! command -v docker >/dev/null 2>&1; then
  log "docker no encontrado en PATH"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  log "curl no encontrado en PATH"
  exit 1
fi

log "levantando stack local (postgres, prometheus, grafana)"
docker compose up -d postgres prometheus grafana

wait_http_ok "$PROM_URL/-/ready" "Prometheus" 60 2
wait_http_ok "$GRAFANA_URL/api/health" "Grafana" 60 2

log "ejecutando smoke de roles"
npm run smoke:roles

log "ejecutando smoke de observabilidad"
npm run smoke:observability

log "ok: stack y smokes completados"
