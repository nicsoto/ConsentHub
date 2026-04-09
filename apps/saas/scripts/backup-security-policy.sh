#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[backup-security-policy] $*"
}

STRICT_BACKUP_SECRETS="${STRICT_BACKUP_SECRETS:-false}"
REQUIRE_ENCRYPTED_OFFSITE="${REQUIRE_ENCRYPTED_OFFSITE:-false}"
BACKUP_ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
BACKUP_ENCRYPTION_KEY_ID="${BACKUP_ENCRYPTION_KEY_ID:-}"
BACKUP_ENCRYPTION_KEY_ROTATED_AT="${BACKUP_ENCRYPTION_KEY_ROTATED_AT:-}"
BACKUP_KEY_MAX_AGE_DAYS="${BACKUP_KEY_MAX_AGE_DAYS:-90}"
OFFSITE_URI="${OFFSITE_URI:-}"

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

if ! [[ "$BACKUP_KEY_MAX_AGE_DAYS" =~ ^[0-9]+$ ]] || [ "$BACKUP_KEY_MAX_AGE_DAYS" -lt 1 ]; then
  log "BACKUP_KEY_MAX_AGE_DAYS invalido: usa entero >= 1"
  exit 1
fi

if [ "$STRICT_BACKUP_SECRETS" != "true" ]; then
  log "politica invalida: STRICT_BACKUP_SECRETS debe estar en true"
  exit 1
fi

if [ "$REQUIRE_ENCRYPTED_OFFSITE" != "true" ]; then
  log "politica invalida: REQUIRE_ENCRYPTED_OFFSITE debe estar en true"
  exit 1
fi

if [ -z "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
  log "politica invalida: BACKUP_ENCRYPTION_PASSPHRASE es requerido"
  exit 1
fi

if [ "${#BACKUP_ENCRYPTION_PASSPHRASE}" -lt 16 ]; then
  log "politica invalida: BACKUP_ENCRYPTION_PASSPHRASE minimo 16 caracteres"
  exit 1
fi

if [ -z "$BACKUP_ENCRYPTION_KEY_ID" ]; then
  log "politica invalida: BACKUP_ENCRYPTION_KEY_ID es requerido"
  exit 1
fi

if [ -z "$BACKUP_ENCRYPTION_KEY_ROTATED_AT" ]; then
  log "politica invalida: BACKUP_ENCRYPTION_KEY_ROTATED_AT es requerido"
  exit 1
fi

if ! command -v date >/dev/null 2>&1; then
  log "date no encontrado en PATH"
  exit 1
fi

ROTATED_EPOCH="$(date -u -d "$BACKUP_ENCRYPTION_KEY_ROTATED_AT" +%s 2>/dev/null || true)"
if [ -z "$ROTATED_EPOCH" ]; then
  log "politica invalida: BACKUP_ENCRYPTION_KEY_ROTATED_AT debe ser fecha valida (ISO8601 recomendado)"
  exit 1
fi

NOW_EPOCH="$(date -u +%s)"
if [ "$ROTATED_EPOCH" -gt "$NOW_EPOCH" ]; then
  log "politica invalida: BACKUP_ENCRYPTION_KEY_ROTATED_AT no puede estar en el futuro"
  exit 1
fi

AGE_DAYS="$(( (NOW_EPOCH - ROTATED_EPOCH) / 86400 ))"
if [ "$AGE_DAYS" -gt "$BACKUP_KEY_MAX_AGE_DAYS" ]; then
  log "politica invalida: key fuera de ventana de rotacion (edad=${AGE_DAYS}d, max=${BACKUP_KEY_MAX_AGE_DAYS}d)"
  exit 1
fi

if [ -n "$OFFSITE_URI" ] && [[ "$OFFSITE_URI" == s3://* ]] && [ "$REQUIRE_ENCRYPTED_OFFSITE" != "true" ]; then
  log "politica invalida: OFFSITE_URI en S3 requiere REQUIRE_ENCRYPTED_OFFSITE=true"
  exit 1
fi

log "ok: policy backup/secretos valida (age_days=${AGE_DAYS}, max_days=${BACKUP_KEY_MAX_AGE_DAYS})"
