#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INPUT_FILE="${1:-}"
REQUIRE_BACKUP_CHECKSUM="${REQUIRE_BACKUP_CHECKSUM:-true}"

log() {
  echo "[db-verify] $*"
}

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/db-verify-backup.sh <backup.dump>

Behavior:
  - Validates sidecar checksum file: <backup.dump>.sha256
  - If REQUIRE_BACKUP_CHECKSUM=true (default), missing checksum fails.
USAGE
}

if [ -z "$INPUT_FILE" ]; then
  usage
  exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
  log "archivo no encontrado: $INPUT_FILE"
  exit 1
fi

if [ "$REQUIRE_BACKUP_CHECKSUM" != "true" ] && [ "$REQUIRE_BACKUP_CHECKSUM" != "false" ]; then
  log "REQUIRE_BACKUP_CHECKSUM invalido: $REQUIRE_BACKUP_CHECKSUM (usar true|false)"
  exit 1
fi

CHECKSUM_FILE="${INPUT_FILE}.sha256"
if [ ! -f "$CHECKSUM_FILE" ]; then
  if [ "$REQUIRE_BACKUP_CHECKSUM" = "true" ]; then
    log "checksum faltante: $CHECKSUM_FILE"
    exit 1
  fi
  log "checksum faltante, validacion omitida por REQUIRE_BACKUP_CHECKSUM=false"
  exit 0
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  log "sha256sum no encontrado en PATH"
  exit 1
fi

log "validando checksum de $INPUT_FILE"
(
  cd "$(dirname "$CHECKSUM_FILE")"
  sha256sum -c "$(basename "$CHECKSUM_FILE")"
)

log "ok: checksum valido"
