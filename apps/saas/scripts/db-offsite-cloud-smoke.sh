#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OFFSITE_SMOKE_URI="${OFFSITE_SMOKE_URI:-}"
OFFSITE_SMOKE_CLEANUP="${OFFSITE_SMOKE_CLEANUP:-true}"
BACKUP_ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
BACKUP_ENCRYPTION_KEY_ID="${BACKUP_ENCRYPTION_KEY_ID:-offsite-smoke-key}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_BASE="${ROOT_DIR}/ops/backups/offsite-smoke-${TIMESTAMP}.dump"

log() {
  echo "[db-offsite-cloud-smoke] $*"
}

if [ -z "$OFFSITE_SMOKE_URI" ] || [[ "$OFFSITE_SMOKE_URI" != s3://* ]]; then
  log "define OFFSITE_SMOKE_URI con formato s3://bucket/prefix"
  exit 1
fi

if [ -z "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
  log "define BACKUP_ENCRYPTION_PASSPHRASE para smoke offsite cifrado"
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  log "aws CLI no encontrado en PATH"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  log "docker no encontrado en PATH"
  exit 1
fi

if [ "$OFFSITE_SMOKE_CLEANUP" != "true" ] && [ "$OFFSITE_SMOKE_CLEANUP" != "false" ]; then
  log "OFFSITE_SMOKE_CLEANUP invalido: usa true o false"
  exit 1
fi

log "ejecutando backup cifrado + offsite cloud"
STRICT_BACKUP_SECRETS=true \
REQUIRE_ENCRYPTED_OFFSITE=true \
BACKUP_ENCRYPTION_KEY_ID="$BACKUP_ENCRYPTION_KEY_ID" \
OFFSITE_URI="$OFFSITE_SMOKE_URI" \
"$ROOT_DIR/scripts/db-backup.sh" "$OUTPUT_BASE"

OUTPUT_FILE="$OUTPUT_BASE"
if [ -f "${OUTPUT_BASE}.enc" ]; then
  OUTPUT_FILE="${OUTPUT_BASE}.enc"
fi

CHECKSUM_FILE="${OUTPUT_FILE}.sha256"
if [ ! -f "$OUTPUT_FILE" ] || [ ! -f "$CHECKSUM_FILE" ]; then
  log "backup local esperado no encontrado"
  exit 1
fi

REMOTE_BACKUP="${OFFSITE_SMOKE_URI%/}/$(basename "$OUTPUT_FILE")"
REMOTE_CHECKSUM="${OFFSITE_SMOKE_URI%/}/$(basename "$CHECKSUM_FILE")"

log "verificando objetos en S3"
aws s3 ls "$REMOTE_BACKUP" >/dev/null
aws s3 ls "$REMOTE_CHECKSUM" >/dev/null

if [ "$OFFSITE_SMOKE_CLEANUP" = "true" ]; then
  log "limpiando objetos de smoke en S3"
  aws s3 rm "$REMOTE_BACKUP" >/dev/null
  aws s3 rm "$REMOTE_CHECKSUM" >/dev/null
fi

log "ok: smoke offsite cloud completado"
