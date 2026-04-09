#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/ops/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

log() {
  echo "[db-prune] $*"
}

if [ ! -d "$BACKUP_DIR" ]; then
  log "directorio de backups no existe, nada que limpiar: $BACKUP_DIR"
  exit 0
fi

if ! [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  log "BACKUP_RETENTION_DAYS invalido: $BACKUP_RETENTION_DAYS"
  exit 1
fi

if [ "$BACKUP_RETENTION_DAYS" -eq 0 ]; then
  log "retencion deshabilitada (BACKUP_RETENTION_DAYS=0), no se elimina nada"
  exit 0
fi

log "eliminando backups con mas de ${BACKUP_RETENTION_DAYS} dias en ${BACKUP_DIR}"
find "$BACKUP_DIR" -type f -name "*.dump" -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete

log "eliminando checksums antiguos"
find "$BACKUP_DIR" -type f -name "*.dump.sha256" -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete

log "eliminando checksums huerfanos"
while IFS= read -r checksum_file; do
  dump_file="${checksum_file%.sha256}"
  if [ ! -f "$dump_file" ]; then
    echo "$checksum_file"
    rm -f "$checksum_file"
  fi
done < <(find "$BACKUP_DIR" -type f -name "*.dump.sha256")

log "ok: limpieza completada"
