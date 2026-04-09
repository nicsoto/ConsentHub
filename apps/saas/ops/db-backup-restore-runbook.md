# DB Backup and Restore Runbook

This runbook covers PostgreSQL backup, restore, and periodic recovery drill for local/ops workflows.

## Prerequisites

- Docker and Docker Compose available.
- `postgres` service running from `docker-compose.yml`.
- Adequate disk space for dump files.

## Backup

Command:

```bash
npm run db:backup
```

Optional output path:

```bash
./scripts/db-backup.sh ops/backups/custom-name.dump
```

Defaults:

- output directory: `ops/backups/`
- format: custom dump (`pg_dump -Fc`)
- db/user: `consenthub` / `postgres`
- retention: backup command triggers automatic prune using `BACKUP_RETENTION_DAYS` (default `14`)
- integrity: backup command generates checksum sidecar (`<file>.dump.sha256`)

Optional hardening:

- backup encryption: set `BACKUP_ENCRYPTION_PASSPHRASE` (output becomes `*.dump.enc`)
- offsite copy: set `OFFSITE_URI`
	- local path example: `/mnt/backups-offsite`
	- S3 example: `s3://my-consenthub-backups/prod` (requires AWS CLI)

Manual prune only:

```bash
npm run db:prune
```

## Restore

Restore is destructive and requires explicit confirmation.

Command:

```bash
FORCE=true npm run db:restore -- ops/backups/<file>.dump
```

Equivalent direct usage:

```bash
FORCE=true ./scripts/db-restore.sh ops/backups/<file>.dump
```

Restore verifies checksum by default. To bypass (not recommended):

```bash
REQUIRE_BACKUP_CHECKSUM=false FORCE=true npm run db:restore -- ops/backups/<file>.dump
```

Encrypted backup restore:

```bash
BACKUP_ENCRYPTION_PASSPHRASE='***' FORCE=true npm run db:restore -- ops/backups/<file>.dump.enc
```

What it does:

1. Copies dump into postgres container.
2. Drops and recreates target database.
3. Restores data with `pg_restore --clean --if-exists`.

## Recovery Drill

Command:

```bash
npm run db:drill
```

What it verifies:

1. Backup creation from primary DB.
2. Restore into temporary drill DB (`consenthub_drill` by default).
3. Basic connectivity query (`SELECT now()`).
4. Cleanup of temporary DB.

Recommended cadence:

- At least monthly.
- Always after major schema changes.

## Cross-Environment Restore Check

Command:

```bash
npm run db:cross-restore
```

What it verifies:

1. Generates a fresh backup from source DB (`db-backup.sh`).
2. Verifies checksum sidecar.
3. If encrypted (`.enc`), decrypts locally with `BACKUP_ENCRYPTION_PASSPHRASE`.
4. Restores into isolated temporary PostgreSQL container (outside compose source DB).
5. Runs connectivity query on restored DB.

Useful overrides:

- `WORK_DIR` (default: `ops/backups`)
- `TARGET_DB` (default: `consenthub_cross_restore`)
- `TARGET_DB_PASSWORD` (default: `postgres`)
- `TARGET_CONTAINER` (auto-generated if omitted)
- `BACKUP_ENCRYPTION_PASSPHRASE` (required when restoring encrypted `.enc`)
- `OFFSITE_URI` (optional, forwarded to backup step)

## Environment Overrides

Supported env vars for scripts:

- `DB_NAME` (default: `consenthub`)
- `DB_USER` (default: `postgres`)
- `BACKUP_DIR` (backup script)
- `BACKUP_RETENTION_DAYS` (default: `14`, `0` disables prune)
- `BACKUP_ENCRYPTION_PASSPHRASE` (optional, enables backup encryption and required for `.enc` restore/drill)
- `OFFSITE_URI` (optional offsite destination: local path or `s3://...`)
- `REQUIRE_BACKUP_CHECKSUM` (default: `true`, restore/verify guard)
- `DRILL_DB` (drill script, default: `consenthub_drill`)
- `TARGET_DB`, `TARGET_DB_PASSWORD`, `TARGET_CONTAINER` (cross-env restore script)

Examples:

```bash
DB_NAME=consenthub DB_USER=postgres npm run db:backup
DRILL_DB=consenthub_restore_test npm run db:drill
```

## Post-Operation Validation

After restore/drill:

1. Run app readiness check (`/readyz`).
2. Validate critical dashboard endpoints.
3. Run targeted test smoke if needed (`npm run smoke:roles`).

## Incident Usage

If restore was part of incident response:

1. Record timeline and rationale in incident doc.
2. Link to `ops/incidents/postmortem-template.md`.
3. Document final data integrity checks performed.
