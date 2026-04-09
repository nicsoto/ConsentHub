#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_NAME="${DB_NAME:-consenthub}"
DB_USER="${DB_USER:-postgres}"
FORCE="${FORCE:-false}"
INPUT_FILE="${1:-}"
TMP_FILE="/tmp/consenthub-restore-$$.dump"
BACKUP_ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
LOCAL_DECRYPTED_FILE="/tmp/consenthub-restore-local-$$.dump"
RESTORE_SOURCE_FILE=""

log() {
  echo "[db-restore] $*"
}

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/db-restore.sh <backup.dump>

Safety:
  Requires FORCE=true to execute restore.

Example:
  FORCE=true ./scripts/db-restore.sh ops/backups/consenthub-consenthub-20260408-120000.dump
USAGE
}

if [ -z "$INPUT_FILE" ]; then
  usage
  exit 1
fi

if [ "$FORCE" != "true" ]; then
  log "restore bloqueado: exporta FORCE=true para confirmar accion destructiva"
  exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
  log "archivo no encontrado: $INPUT_FILE"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  log "docker no encontrado en PATH"
  exit 1
fi

"$ROOT_DIR/scripts/db-verify-backup.sh" "$INPUT_FILE"

RESTORE_SOURCE_FILE="$INPUT_FILE"
if [[ "$INPUT_FILE" == *.enc ]]; then
  if [ -z "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
    log "backup cifrado detectado (.enc): define BACKUP_ENCRYPTION_PASSPHRASE"
    exit 1
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    log "openssl no encontrado en PATH (requerido para descifrar backups .enc)"
    exit 1
  fi

  log "descifrando backup cifrado para restauracion"
  openssl enc -d -aes-256-cbc -pbkdf2 \
    -in "$INPUT_FILE" \
    -out "$LOCAL_DECRYPTED_FILE" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE

  RESTORE_SOURCE_FILE="$LOCAL_DECRYPTED_FILE"
fi

log "copiando backup al contenedor postgres"
docker compose cp "$RESTORE_SOURCE_FILE" "postgres:${TMP_FILE}"

log "restaurando base ${DB_NAME} (drop/create + pg_restore)"
docker compose exec -T postgres sh -lc "dropdb -U '$DB_USER' --if-exists '$DB_NAME' && createdb -U '$DB_USER' '$DB_NAME' && pg_restore -U '$DB_USER' -d '$DB_NAME' --clean --if-exists '${TMP_FILE}'"

docker compose exec -T postgres rm -f "$TMP_FILE" >/dev/null 2>&1 || true
rm -f "$LOCAL_DECRYPTED_FILE" >/dev/null 2>&1 || true

log "ok: restore completado"
