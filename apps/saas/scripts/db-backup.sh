#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/ops/backups}"
DB_NAME="${DB_NAME:-consenthub}"
DB_USER="${DB_USER:-postgres}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="${1:-$BACKUP_DIR/consenthub-${DB_NAME}-${TIMESTAMP}.dump}"
CHECKSUM_FILE="${OUTPUT_FILE}.sha256"
BACKUP_ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
BACKUP_ENCRYPTION_KEY_ID="${BACKUP_ENCRYPTION_KEY_ID:-}"
OFFSITE_URI="${OFFSITE_URI:-}"
STRICT_BACKUP_SECRETS="${STRICT_BACKUP_SECRETS:-false}"
REQUIRE_ENCRYPTED_OFFSITE="${REQUIRE_ENCRYPTED_OFFSITE:-false}"

log() {
  echo "[db-backup] $*"
}

validate_bool() {
  local value="$1"
  local name="$2"
  if [ "$value" != "true" ] && [ "$value" != "false" ]; then
    log "${name} invalido: usa true o false"
    exit 1
  fi
}

validate_bool "$STRICT_BACKUP_SECRETS" "STRICT_BACKUP_SECRETS"
validate_bool "$REQUIRE_ENCRYPTED_OFFSITE" "REQUIRE_ENCRYPTED_OFFSITE"

if [ -n "$OFFSITE_URI" ] && [ "$REQUIRE_ENCRYPTED_OFFSITE" = "true" ] && [ -z "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
  log "OFFSITE_URI configurado: define BACKUP_ENCRYPTION_PASSPHRASE o desactiva REQUIRE_ENCRYPTED_OFFSITE"
  exit 1
fi

if [ "$STRICT_BACKUP_SECRETS" = "true" ]; then
  if [ -z "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
    log "STRICT_BACKUP_SECRETS=true requiere BACKUP_ENCRYPTION_PASSPHRASE"
    exit 1
  fi

  if [ "${#BACKUP_ENCRYPTION_PASSPHRASE}" -lt 16 ]; then
    log "BACKUP_ENCRYPTION_PASSPHRASE demasiado corto: minimo 16 caracteres en modo estricto"
    exit 1
  fi

  if [ -z "$BACKUP_ENCRYPTION_KEY_ID" ]; then
    log "STRICT_BACKUP_SECRETS=true requiere BACKUP_ENCRYPTION_KEY_ID para auditoria de rotacion"
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  log "docker no encontrado en PATH"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

log "creando backup de ${DB_NAME} en ${OUTPUT_FILE}"
docker compose exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$OUTPUT_FILE"

if [ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    log "openssl no encontrado en PATH (requerido para cifrar backups)"
    exit 1
  fi

  ENCRYPTED_FILE="${OUTPUT_FILE}.enc"
  if [ -n "$BACKUP_ENCRYPTION_KEY_ID" ]; then
    log "cifrando backup en ${ENCRYPTED_FILE} (key-id=${BACKUP_ENCRYPTION_KEY_ID})"
  else
    log "cifrando backup en ${ENCRYPTED_FILE}"
  fi
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$OUTPUT_FILE" \
    -out "$ENCRYPTED_FILE" \
    -pass env:BACKUP_ENCRYPTION_PASSPHRASE

  rm -f "$OUTPUT_FILE"
  OUTPUT_FILE="$ENCRYPTED_FILE"
  CHECKSUM_FILE="${OUTPUT_FILE}.sha256"
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  log "sha256sum no encontrado en PATH"
  exit 1
fi

log "generando checksum SHA256 en ${CHECKSUM_FILE}"
(
  cd "$(dirname "$OUTPUT_FILE")"
  sha256sum "$(basename "$OUTPUT_FILE")" > "$(basename "$CHECKSUM_FILE")"
)

if [ -n "$OFFSITE_URI" ]; then
  case "$OFFSITE_URI" in
    s3://*)
      if ! command -v aws >/dev/null 2>&1; then
        log "aws CLI no encontrado en PATH (requerido para OFFSITE_URI=s3://...)"
        exit 1
      fi

      log "subiendo backup y checksum a ${OFFSITE_URI}"
      aws s3 cp "$OUTPUT_FILE" "${OFFSITE_URI%/}/$(basename "$OUTPUT_FILE")"
      aws s3 cp "$CHECKSUM_FILE" "${OFFSITE_URI%/}/$(basename "$CHECKSUM_FILE")"
      ;;
    *)
      log "copiando backup y checksum a offsite local ${OFFSITE_URI}"
      mkdir -p "$OFFSITE_URI"
      cp "$OUTPUT_FILE" "${OFFSITE_URI%/}/$(basename "$OUTPUT_FILE")"
      cp "$CHECKSUM_FILE" "${OFFSITE_URI%/}/$(basename "$CHECKSUM_FILE")"
      ;;
  esac
fi

"$ROOT_DIR/scripts/db-prune-backups.sh"

log "ok: backup generado"
