#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_NAME="${DB_NAME:-consenthub}"
DB_USER="${DB_USER:-postgres}"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/ops/backups}"
TARGET_DB="${TARGET_DB:-consenthub_cross_restore}"
TARGET_DB_PASSWORD="${TARGET_DB_PASSWORD:-postgres}"
TARGET_CONTAINER="${TARGET_CONTAINER:-consenthub-cross-restore-$$}"
BACKUP_ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_BASE="${WORK_DIR}/crossenv-${DB_NAME}-${TIMESTAMP}.dump"
LOCAL_DECRYPTED_FILE="/tmp/consenthub-cross-restore-${TIMESTAMP}.dump"
RESTORE_SOURCE_FILE=""

log() {
  echo "[db-cross-env] $*"
}

cleanup() {
  docker rm -f "$TARGET_CONTAINER" >/dev/null 2>&1 || true
  rm -f "$LOCAL_DECRYPTED_FILE" >/dev/null 2>&1 || true
}

trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  log "docker no encontrado en PATH"
  exit 1
fi

mkdir -p "$WORK_DIR"

log "generando backup base para restore cross-env"
"$ROOT_DIR/scripts/db-backup.sh" "$BACKUP_BASE"

if [ -f "${BACKUP_BASE}.enc" ]; then
  BACKUP_FILE="${BACKUP_BASE}.enc"
else
  BACKUP_FILE="$BACKUP_BASE"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  log "backup esperado no encontrado: $BACKUP_FILE"
  exit 1
fi

"$ROOT_DIR/scripts/db-verify-backup.sh" "$BACKUP_FILE"

RESTORE_SOURCE_FILE="$BACKUP_FILE"
if [[ "$BACKUP_FILE" == *.enc ]]; then
  if [ -z "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
    log "backup cifrado detectado (.enc): define BACKUP_ENCRYPTION_PASSPHRASE"
    exit 1
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    log "openssl no encontrado en PATH (requerido para descifrar backup .enc)"
    exit 1
  fi

  log "descifrando backup para restauracion cross-env"
  openssl enc -d -aes-256-cbc -pbkdf2 \
    -in "$BACKUP_FILE" \
    -out "$LOCAL_DECRYPTED_FILE" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE

  RESTORE_SOURCE_FILE="$LOCAL_DECRYPTED_FILE"
fi

log "levantando postgres temporal aislado: $TARGET_CONTAINER"
docker run -d --name "$TARGET_CONTAINER" \
  -e POSTGRES_DB="$TARGET_DB" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$TARGET_DB_PASSWORD" \
  postgres:16-alpine >/dev/null

log "esperando readiness de postgres temporal"
for i in $(seq 1 40); do
  if docker exec "$TARGET_CONTAINER" pg_isready -U "$DB_USER" -d "$TARGET_DB" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 40 ]; then
    log "timeout esperando postgres temporal"
    exit 1
  fi
  sleep 2
done

TMP_FILE="/tmp/consenthub-cross-restore-${TIMESTAMP}.dump"
log "copiando backup al contenedor temporal"
docker cp "$RESTORE_SOURCE_FILE" "${TARGET_CONTAINER}:${TMP_FILE}"

log "restaurando backup en DB temporal ${TARGET_DB}"
docker exec "$TARGET_CONTAINER" sh -lc "dropdb -U '$DB_USER' --if-exists '$TARGET_DB' && createdb -U '$DB_USER' '$TARGET_DB' && pg_restore -U '$DB_USER' -d '$TARGET_DB' --clean --if-exists '${TMP_FILE}'"

log "verificando conectividad de base restaurada"
docker exec "$TARGET_CONTAINER" psql -U "$DB_USER" -d "$TARGET_DB" -c "SELECT now() AS restored_at;" >/dev/null

log "ok: restore cross-env completado"
