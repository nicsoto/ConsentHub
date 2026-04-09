#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_NAME="${DB_NAME:-consenthub}"
DB_USER="${DB_USER:-postgres}"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/ops/backups}"
DRILL_DB="${DRILL_DB:-consenthub_drill}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${WORK_DIR}/drill-${DB_NAME}-${TIMESTAMP}.dump"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
TMP_FILE="/tmp/consenthub-drill-${TIMESTAMP}.dump"
BACKUP_ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
LOCAL_DECRYPTED_FILE="/tmp/consenthub-drill-local-${TIMESTAMP}.dump"
DRILL_SOURCE_FILE=""

log() {
  echo "[db-drill] $*"
}

if ! command -v docker >/dev/null 2>&1; then
  log "docker no encontrado en PATH"
  exit 1
fi

mkdir -p "$WORK_DIR"

log "generando backup base (${BACKUP_FILE})"
docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$BACKUP_FILE"

if [ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    log "openssl no encontrado en PATH (requerido para cifrar backups)"
    exit 1
  fi

  ENCRYPTED_FILE="${BACKUP_FILE}.enc"
  log "cifrando backup de drill en ${ENCRYPTED_FILE}"
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$BACKUP_FILE" \
    -out "$ENCRYPTED_FILE" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE

  rm -f "$BACKUP_FILE"
  BACKUP_FILE="$ENCRYPTED_FILE"
  CHECKSUM_FILE="${BACKUP_FILE}.sha256"
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  log "sha256sum no encontrado en PATH"
  exit 1
fi

log "generando checksum SHA256 de backup de drill"
(
  cd "$(dirname "$BACKUP_FILE")"
  sha256sum "$(basename "$BACKUP_FILE")" > "$(basename "$CHECKSUM_FILE")"
)

bash "$ROOT_DIR/scripts/db-verify-backup.sh" "$BACKUP_FILE"

DRILL_SOURCE_FILE="$BACKUP_FILE"
if [[ "$BACKUP_FILE" == *.enc ]]; then
  if ! command -v openssl >/dev/null 2>&1; then
    log "openssl no encontrado en PATH (requerido para descifrar backup .enc)"
    exit 1
  fi

  log "descifrando backup cifrado para restauracion de drill"
  openssl enc -d -aes-256-cbc -pbkdf2 \
    -in "$BACKUP_FILE" \
    -out "$LOCAL_DECRYPTED_FILE" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE

  DRILL_SOURCE_FILE="$LOCAL_DECRYPTED_FILE"
fi

log "copiando backup para restauracion de prueba"
docker compose cp "$DRILL_SOURCE_FILE" "postgres:${TMP_FILE}"

log "restaurando en base temporal ${DRILL_DB}"
docker compose exec -T postgres sh -lc "dropdb -U '$DB_USER' --if-exists '$DRILL_DB' && createdb -U '$DB_USER' '$DRILL_DB' && pg_restore -U '$DB_USER' -d '$DRILL_DB' --clean --if-exists '${TMP_FILE}'"

log "verificando conectividad de base restaurada"
docker compose exec -T postgres psql -U "$DB_USER" -d "$DRILL_DB" -c "SELECT now() AS restored_at;" >/dev/null

log "limpiando recursos de drill"
docker compose exec -T postgres sh -lc "dropdb -U '$DB_USER' --if-exists '$DRILL_DB' && rm -f '${TMP_FILE}'"
rm -f "$LOCAL_DECRYPTED_FILE" >/dev/null 2>&1 || true

log "ok: drill backup/restore completado"
