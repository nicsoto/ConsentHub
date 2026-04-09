# ConsentHub - Implementacion y Estado Actual

Fecha: 2026-04-08

Este documento resume de forma ejecutiva y tecnica:

- Que se implemento.
- Que no se implemento.
- Por que algunas cosas quedaron fuera.
- Estado final del stream de trabajo.

## 1) Resumen ejecutivo

Se completo un hardening amplio en `apps/saas` para pasar de una base MVP a una operacion mucho mas robusta:

- Salud del servicio con liveness/readiness real.
- Trazabilidad por request-id y logging estructurado.
- Auditoria persistida con export, paginacion cursor y limites.
- Observabilidad de workers (estado runtime + historial persistido).
- Stack local de observabilidad (Prometheus + Grafana) con dashboards, alertas y recording rules.
- CI gate de observabilidad.
- Runbooks operativos e incident/postmortem templates.
- Resiliencia de datos con backup/restore/drill, checksum y retencion.

## 2) Lo que SI se hizo (implementado)

## 2.1 Arquitectura runtime y salud

- Split de procesos por rol (`APP_ROLE=web|worker|all`).
- Endpoints de salud:
  - `/livez` (liveness)
  - `/readyz` (readiness)
  - `/health` (alias compat)
- Checks de readiness con timeout y razones de falla:
  - DB
  - Stripe (opcional)

Archivos principales:

- `apps/saas/src/routes/health.js`
- `apps/saas/src/server.js`
- `apps/saas/src/worker.js`
- `apps/saas/src/config/env.js`

## 2.2 Seguridad y trazabilidad

- `x-request-id` propagado/generado en middleware global.
- Logging estructurado para readiness y errores globales.
- Manejo de JSON invalido con respuesta 400 controlada.
- Endurecimiento de `/metrics`:
  - token bearer opcional/general
  - obligatorio en prod si metrics habilitadas
  - allowlist opcional de IPs

Archivos principales:

- `apps/saas/src/middleware/requestId.js`
- `apps/saas/src/lib/logger.js`
- `apps/saas/src/app.js`
- `apps/saas/src/routes/metrics.js`
- `apps/saas/src/config/env.js`

## 2.3 Auditoria y endpoints de dashboard

Se robustecio capa de auditoria:

- Modelo persistente `AuditLog`.
- Endpoint JSON con filtros + cursor.
- Endpoint CSV.
- Manejo de cursor invalido (400).
- Rate-limit para endpoints sensibles.
- Endpoint de config operativa no secreta.

Tambien se agrego observabilidad de worker en dashboard:

- Estado runtime de jobs.
- Historial de jobs con filtros, cursor y export CSV.

Archivos principales:

- `apps/saas/prisma/schema.prisma`
- `apps/saas/src/data/store.js`
- `apps/saas/src/routes/dashboard.js`
- `apps/saas/tests/dashboard-retention.test.js`

## 2.4 Instrumentacion Prometheus

- Endpoint `/metrics` compatible Prometheus.
- Metricas de requests HTTP + latencia histograma.
- Metricas de rechazos de rate-limit.
- Recording rules preagregadas.
- Alertas base operativas.

Archivos principales:

- `apps/saas/src/lib/metrics.js`
- `apps/saas/src/middleware/httpMetrics.js`
- `apps/saas/src/routes/metrics.js`
- `apps/saas/ops/prometheus/recording.rules.yml`
- `apps/saas/ops/prometheus/alerts.rules.yml`
- `apps/saas/ops/prometheus/prometheus.local.yml`
- `apps/saas/ops/prometheus/prometheus.example.yml`

## 2.5 Grafana y stack local

- Dashboard base versionado.
- Provisioning de datasource y dashboards.
- Compose extendido con Postgres + Prometheus + Grafana.

Archivos principales:

- `apps/saas/ops/grafana/consenthub-overview.dashboard.json`
- `apps/saas/ops/grafana/provisioning/datasources/prometheus.yml`
- `apps/saas/ops/grafana/provisioning/dashboards/consenthub.yml`
- `apps/saas/docker-compose.yml`

## 2.6 Smokes, verificacion y CI

Se unifico validacion local y CI:

- Smokes:
  - `smoke:roles`
  - `smoke:observability`
  - `smoke:all`
- Verificacion observability local:
  - `validate:prometheus`
  - `verify:observability`
- CI observability:
  - checks en PR/push
  - integration-smoke como gate

Archivos principales:

- `apps/saas/scripts/smoke-roles.js`
- `apps/saas/scripts/smoke-observability.js`
- `apps/saas/scripts/dev-observability.sh`
- `apps/saas/scripts/validate-prometheus-rules.sh`
- `apps/saas/.github/workflows/observability.yml`
- `apps/saas/package.json`

## 2.7 Runbooks e incident response

- Runbook de observabilidad con playbooks por alerta.
- Template de postmortem.
- Carpeta de incidentes con convencion.

Archivos principales:

- `apps/saas/ops/observability-runbook.md`
- `apps/saas/ops/incidents/postmortem-template.md`
- `apps/saas/ops/incidents/README.md`

## 2.8 Resiliencia de datos (backup/restore/drill)

- Backup con `pg_dump -Fc`.
- Restore destructivo protegido por `FORCE=true`.
- Drill de restauracion en DB temporal.
- Retencion de backups por dias (prune).
- Integridad de backup por checksum SHA256:
  - generado en backup
  - validado en restore y drill
- CI dedicado para db-drill:
  - manual + cron semanal
  - upload de dump y checksum como artifact

Archivos principales:

- `apps/saas/scripts/db-backup.sh`
- `apps/saas/scripts/db-prune-backups.sh`
- `apps/saas/scripts/db-verify-backup.sh`
- `apps/saas/scripts/db-restore.sh`
- `apps/saas/scripts/db-drill.sh`
- `apps/saas/.github/workflows/db-drill.yml`
- `apps/saas/ops/db-backup-restore-runbook.md`

## 2.9 Billing webhook matrix formal

- Se documento una matriz formal de eventos Stripe para billing con:
  - comportamiento esperado por evento
  - estado de cobertura (DONE)
  - referencia directa a pruebas existentes
- Se consolidaron reglas transversales de idempotencia y validacion de firma.

Archivos principales:

- `apps/saas/ops/stripe-webhook-event-matrix.md`
- `apps/saas/src/routes/billing.js`
- `apps/saas/tests/billing-webhook-flow.test.js`
- `apps/saas/tests/billing-alerts.test.js`

## 2.10 Tests automatizados iniciales para scripts DB

- Se agrego una suite automatizada para scripts de resiliencia DB con cobertura de guard-rails y flujos mockeados:
  - `db-verify-backup.sh` (input requerido, checksum faltante permitido bajo flag, checksum valido, env invalida)
  - `db-backup.sh` (flujo exitoso con docker mockeado, dump + checksum)
  - `db-prune-backups.sh` (retencion invalida, checksum huerfano, borrado por antiguedad)
  - `db-restore.sh` (bloqueo por `FORCE!=true`, archivo inexistente, flujo positivo mockeado)
  - `db-drill.sh` (flujo completo mockeado con compose exec/cp y verificacion)
- Se amplio cobertura con casos funcionales adicionales:
  - checksum invalido (falla esperada)
  - verificacion explicita de invocaciones docker compose esperadas

Archivo principal:

- `apps/saas/tests/db-scripts.test.js`

## 2.11 Performance budget baseline automatizado

- Se implemento un runner de budget de performance (latencia y error rate) para endpoints operativos.
- Se agrego workflow CI programado semanal para ejecutar budget check en modo test.
- Se amplio el runner para escenarios mixtos HTTP (`PERF_SCENARIOS_JSON`) incluyendo endpoints de negocio (`POST /consent-events`).
- Se agrego soporte de SLA granular por escenario/ruta con `PERF_SCENARIO_BUDGETS_JSON` (p95/error rate por endpoint).

Archivos principales:

- `apps/saas/scripts/perf-budget.js`
- `apps/saas/.github/workflows/performance.yml`
- `apps/saas/package.json`

## 2.12 Avance en resiliencia enterprise de backups (cifrado + offsite)

- Se implemento cifrado opcional de backups con passphrase (`BACKUP_ENCRYPTION_PASSPHRASE`) en `db-backup.sh`.
- Se implemento copia offsite opcional en `db-backup.sh` via:
  - ruta local de filesystem
  - `s3://...` con AWS CLI
- Se agrego soporte para restaurar desde backups cifrados (`.enc`) en:
  - `db-restore.sh`
  - `db-drill.sh`
- Se agrego check automatizado de restore cross-env con script dedicado y workflow CI semanal.
- Se agregaron pruebas automatizadas para estos caminos en `tests/db-scripts.test.js`.

Archivos principales:

- `apps/saas/scripts/db-backup.sh`
- `apps/saas/scripts/db-restore.sh`
- `apps/saas/scripts/db-drill.sh`
- `apps/saas/scripts/db-cross-env-restore.sh`
- `apps/saas/tests/db-scripts.test.js`
- `apps/saas/.env.example`
- `apps/saas/.github/workflows/db-cross-env-restore.yml`

## 3) Lo que NO se hizo (pendiente) y por que

## 3.1 Dashboard frontend separado (no SSR en string)

Estado: IMPLEMENTADO.

Avance implementado:

- Se agrego una UI separada basada en archivos estaticos para dashboard: `GET /dashboard-v2`.
- Se incorporo endpoint JSON dedicado para frontend: `GET /dashboard-v2/data`.
- Se migraron flujos de escritura a V2 via endpoints JSON:
  - retencion (`/dashboard-v2/retention`, `/dashboard-v2/retention/run`)
  - billing alerts (`/dashboard-v2/billing-alerts/:id/resolve`, `/dashboard-v2/billing-alerts/escalate`)
  - credenciales API (`/dashboard-v2/api-credentials/create`, `/dashboard-v2/api-credentials/:id/revoke`, `/dashboard-v2/api-credentials/regenerate-ingest`)

Nota:

- El dashboard clasico se mantiene como compatibilidad durante la transicion.

## 3.2 SSO / RBAC enterprise avanzado / admin multi-tenant

Estado: IMPLEMENTADO.

Avance implementado:

- SSO bridge via cabeceras confiables para entornos enterprise con reverse-proxy/IdP gateway:
  - `GET /auth/sso`
  - `DASHBOARD_SSO_ENABLED`, `DASHBOARD_SSO_HEADER_SECRET`, `DASHBOARD_SSO_HEADER_EMAIL`, `DASHBOARD_SSO_HEADER_SITES`
  - soporte opcional de JWT firmado HS256 en header (`DASHBOARD_SSO_HEADER_JWT`, `DASHBOARD_SSO_JWT_SECRET`) con validacion de firma y expiracion
- Integracion OIDC nativa (authorization code flow) para proveedor corporativo:
  - `GET /auth/oidc/start`
  - `GET /auth/oidc/callback`
  - discovery OIDC, token exchange y validacion de `id_token` RS256 contra JWKS
  - proteccion de flujo con `state` + `nonce`
- Resolucion de acceso centralizada por politicas persistentes (`DashboardAccessPolicy`) con fallback a variables de entorno.
- Migracion Prisma agregada para `DashboardAccessPolicy` y script de despliegue `npm run db:migrate:deploy`.
- RBAC y scope multi-tenant en sesion:
  - claims de `role` y `sites` en cookie de sesion (con compatibilidad legacy)
  - permisos por rol (`admin`, `operator`, `billing_manager`, `analyst`)
  - enforcement de acceso por sitio en endpoints mutables de `dashboard-v2`
- Hardening de rutas legacy para evitar bypass de permisos:
  - enforcement RBAC/scope en endpoints mutables de `/dashboard/*`
  - enforcement RBAC/scope en endpoints de `/billing/*`
- Politica de acceso por usuario configurable via `DASHBOARD_ACCESS_POLICIES`.
- Gestion admin desde dashboard-v2 para altas/bajas/edicion de politicas de acceso.

Estado actualizado: IMPLEMENTADO para OIDC enterprise + RBAC multi-tenant.

Cierre operativo agregado:

- Runbook de rollout/onboarding/offboarding enterprise: `apps/saas/ops/enterprise-auth-runbook.md`.
- Cobertura adicional de hardening en tests de auth/config para OIDC.
- Gate CI dedicado para auth enterprise: `apps/saas/.github/workflows/auth-enterprise.yml` con `npm run verify:auth-enterprise`.
- Bridge SSO fail-closed por configuracion: `/auth/sso` rechaza (`503`) cuando no hay secreto configurado.
- API de consent con ownership por key scoped/db-scoped validado por sitio en ingesta/lectura/export.
- Enforcement de `historyDays` por plan en `GET /consent-events` y export CSV.
- Pais por defecto configurable (`DEFAULT_COUNTRY_CODE`), sin hardcode fijo en capa store.
- Optimizacion de dashboard para evitar N+1 en uso mensual por sitio (agregacion batch en store).

Pendiente opcional de plataforma:

- Integracion SAML nativa (solo si la plataforma exige SAML directo en app en lugar de gateway/bridge).

## 3.3 Performance budgets + carga periodica automatizada

Estado: IMPLEMENTADO.

Avance implementado:

- workflow semanal con escenarios mixtos operativos y de negocio.
- budgets globales y por escenario/ruta con `PERF_SCENARIO_BUDGETS_JSON`.

## 3.4 Resiliencia enterprise offsite/cifrado/cross-env restore

Estado: IMPLEMENTADO.

Avance adicional:

- Workflow `apps/saas/.github/workflows/db-drill.yml` ahora tambien se ejecuta en push/PR cuando cambian scripts/tests DB, sumando smoke real continuo sobre contenedores.
- Guardrails de secretos/offsite en backups: modo estricto (`STRICT_BACKUP_SECRETS`), `BACKUP_ENCRYPTION_KEY_ID` para auditoria y bloqueo de offsite sin cifrado (`REQUIRE_ENCRYPTED_OFFSITE`).
- Workflow de smoke cloud real: `apps/saas/.github/workflows/db-offsite-cloud-smoke.yml` (schedule/manual) con validacion de backup cifrado y presencia en S3.
- Policy-as-code de secretos y rotacion: `apps/saas/scripts/backup-security-policy.sh` + workflow `apps/saas/.github/workflows/backup-security-policy.yml`.

Nota operativa:

- El workflow cloud smoke requiere configurar secretos de CI (`OFFSITE_SMOKE_URI`, credenciales AWS, passphrase y key-id).

## 4) Riesgos residuales conocidos

- En esta sesion, la salida de terminal se vio intermitente (varias ejecuciones devolvieron solo eco de comando), por lo que algunas validaciones runtime no siempre mostraron pass/fail completo en consola.
- La suite de scripts DB usa mocks de docker para CI y pruebas unitarias; aun conviene complementar con ejecuciones de smoke en entorno real de contenedores.

## 5) Estado final del plan trabajado

Resultado: plan operativo principal COMPLETADO.

Incluye:

- Observabilidad end-to-end.
- Gates CI de observabilidad.
- Runbooks y postmortem workflow.
- Resiliencia de datos base con checksums y drills periodicos.
- Documentacion principal alineada en `apps/saas` y README raiz actualizada a estado real.

## 6) Siguientes pasos recomendados (orden sugerido)

1. Agregar smoke real de scripts DB sobre contenedores efimeros (ademas de mocks), para detectar diferencias de entorno.
2. Completar hardening de gestion de llaves/secretos para offsite backups (rotacion y auditoria operativa).
3. Mantener y ajustar budgets de performance por SLA de producto a medida que crezca el trafico real.
4. Evaluar implementacion SAML nativa solo si la plataforma la exige; en caso contrario, mantener OIDC nativo + bridge gateway.

---

Si se necesita, este documento puede versionarse por fecha (por ejemplo `IMPLEMENTACION_Y_ESTADO_2026-04-08.md`) para llevar historial de avance en el repo.
