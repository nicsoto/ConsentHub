# ConsentHub SaaS (apps/saas)

## Runtime Roles

This service supports role-based process split through `APP_ROLE`:

- `web`: starts HTTP server only.
- `worker`: starts background jobs only.
- `all`: runs both capabilities in the same process.

Recommended production topology:

1. Run one deployment/service for `APP_ROLE=web`.
2. Run another deployment/service for `APP_ROLE=worker`.

Quick deploy resources:

- Render blueprint: `render.yaml`
- Step-by-step deploy guide: `docs/deploy-render.md`
- Validate production env before publish: `npm run verify:prod-env`

## Health Endpoints

### `GET /livez`

Liveness probe for process health.

- Intended use: restart crashed/hung process.
- Does not verify dependencies.
- Returns `200` when process is alive.

Response (example):

```json
{
  "ok": true,
  "service": "consenthub-saas",
  "version": "0.1.0",
  "role": "web",
  "jobsInThisProcess": false,
  "webInThisProcess": true
}
```

### `GET /readyz`

Readiness probe for traffic acceptance.

- Intended use: load balancer / orchestrator readiness gate.
- Verifies dependencies (DB and optionally Stripe).
- Returns `200` when ready, `503` when not ready.

### `GET /health`

Backward-compatible alias of readiness.

- Same behavior and payload shape as `/readyz`.

## Metrics Endpoint

### `GET /metrics`

Prometheus-compatible metrics exposition.

- Returns `text/plain; version=0.0.4`.
- Includes HTTP request counters and latency aggregates.
- Includes rate-limit rejection counters.

Current metric families:

- `consenthub_http_requests_total{method,route,status}`
- `consenthub_http_request_duration_ms_bucket{method,route,status,le}`
- `consenthub_http_request_duration_ms_sum{method,route,status}`
- `consenthub_http_request_duration_ms_count{method,route,status}`
- `consenthub_rate_limit_rejections_total{keyPrefix,route}`

Included latency buckets (ms): `25, 50, 100, 250, 500, 1000, 2500, 5000, +Inf`.

Security/options:

- `METRICS_ENABLED=false` disables endpoint (returns `404`).
- If `METRICS_BEARER_TOKEN` is set, `Authorization: Bearer <token>` is required.
- In production, `METRICS_BEARER_TOKEN` is mandatory when `METRICS_ENABLED=true`.
- Optional `METRICS_ALLOWED_IPS` restricts `/metrics` access to specific source IPs.

## Readiness Checks

Readiness payload includes `checks` per dependency:

- `checks.db`
  - `status`: `ok`, `skipped`, `error`
  - `reason` (when relevant): `in-memory-store`, `timeout`, `query-failed`
  - `durationMs`: probe duration

- `checks.stripe`
  - `status`: `ok`, `skipped`, `error`
  - `reason` (when relevant): `disabled`, `missing-config`, `client-unavailable`, `timeout`, `probe-failed`
  - `durationMs`: probe duration

## Request ID and Traceability

All routes include request correlation support:

- Incoming `x-request-id` is propagated if provided.
- If missing, server generates one.
- Response always contains `x-request-id` header.
- Error JSON (`500`) includes `requestId`.

Operational workflow:

1. Capture `x-request-id` from client response.
2. Search structured logs by `requestId`.
3. Use matching `readiness_check` or `unhandled_error` entries for diagnosis.

## Structured Logs

Current structured events:

- `readiness_check`
  - Includes readiness result and dependency details.
  - `level=info` when `ok=true`, `level=error` when `ok=false`.

- `unhandled_error`
  - Emitted by global error middleware.
  - Includes method, path, error name/message, and request ID.

- `invalid_json_payload`
  - Emitted when request body parsing fails.
  - Returns `400` with `requestId` in response body.

## Dashboard Audit Logs

Sensitive dashboard actions are persisted in audit logs (actor, action, site, requestId, metadata).

Authenticated endpoint:

- `GET /dashboard/audit-logs?site=&action=&actorEmail=&limit=100`
- `GET /dashboard/audit-logs.csv?site=&action=&actorEmail=&limit=1000`
- `GET /dashboard/ops-config` (effective runtime config, non-secret)
- `GET /dashboard/worker-jobs-status` (runtime state of worker jobs in this process)
- `GET /dashboard/worker-jobs-history?job=retention|billing-alerts&status=success|error&limit=50&cursor=...`
- `GET /dashboard/worker-jobs-history.csv?job=retention|billing-alerts&status=success|error&limit=1000&cursor=...`

Response includes:

- `total`
- `filters`
- `nextCursor` (for cursor-based pagination)
- `logs[]`

Pagination example:

1. Request first page with `limit`.
2. Read `nextCursor` from response.
3. Request next page with `cursor=<nextCursor>`.

If `cursor` is malformed, API returns `400` with `Cursor de auditoria invalido` for audit logs and `Cursor de historial invalido` for worker jobs history.

Audit and worker history endpoints are rate-limited using the same shared budget (JSON and CSV variants). Exceeded requests return `429` with `Retry-After`.

## Dashboard V2 (frontend separado)

Se agrego una version de dashboard separada del HTML inline clasico:

- `GET /dashboard-v2` (UI en archivos estaticos)
- `GET /dashboard-v2/data?site=&days=&limit=` (payload JSON para render del frontend)
- `POST /dashboard-v2/retention` (actualiza retencion por sitio)
- `POST /dashboard-v2/retention/run` (ejecuta cleanup)
- `POST /dashboard-v2/billing-alerts/:id/resolve`
- `POST /dashboard-v2/billing-alerts/escalate`
- `POST /dashboard-v2/api-credentials/create`
- `POST /dashboard-v2/api-credentials/:id/revoke`
- `POST /dashboard-v2/api-credentials/regenerate-ingest`
- `GET /dashboard-v2/access-policies` (admin)
- `POST /dashboard-v2/access-policies/upsert` (admin)
- `POST /dashboard-v2/access-policies/delete` (admin)
- `GET /auth/oidc/start` (inicio de login OIDC enterprise)
- `GET /auth/oidc/callback` (callback OIDC con code flow)

Archivos principales:

- `src/public/dashboard-v2/index.html`
- `src/public/dashboard-v2/assets/styles.css`
- `src/public/dashboard-v2/assets/app.js`

## Environment Variables

Health/readiness and audit-related variables:

- `APP_ROLE=web|worker|all`
- `READINESS_CHECK_STRIPE=false`
- `READINESS_DB_TIMEOUT_MS=1500`
- `READINESS_STRIPE_TIMEOUT_MS=1500`
- `AUDIT_LOGS_RATE_LIMIT_WINDOW_MS=60000`
- `AUDIT_LOGS_RATE_LIMIT_MAX=10`
- `ALLOW_LEGACY_API_KEYS=true|false` (default recomendado y seguro: `false`)
- `DEFAULT_COUNTRY_CODE=CL` (fallback para `country` en ingesta)
- `METRICS_ENABLED=true|false`
- `METRICS_BEARER_TOKEN=<optional-bearer-token>`
- `DASHBOARD_ACCESS_POLICIES=email|role|site1,site2;email2|role|*`
- `DASHBOARD_SSO_ENABLED=true|false`
- `DASHBOARD_SSO_HEADER_SECRET=<shared-secret-opcional>`
- `DASHBOARD_SSO_HEADER_EMAIL=x-sso-email`
- `DASHBOARD_SSO_HEADER_SITES=x-sso-sites`
- `DASHBOARD_SSO_HEADER_JWT=x-sso-jwt`
- `DASHBOARD_SSO_JWT_SECRET=<jwt-secret-opcional-hs256>`
- `DASHBOARD_OIDC_ENABLED=true|false`
- `DASHBOARD_OIDC_ISSUER=https://idp.empresa.com`
- `DASHBOARD_OIDC_DISCOVERY_URL=<opcional-override-discovery>`
- `DASHBOARD_OIDC_CLIENT_ID=<oidc-client-id>`
- `DASHBOARD_OIDC_CLIENT_SECRET=<oidc-client-secret>`
- `DASHBOARD_OIDC_REDIRECT_URI=<opcional-default-app-base-url-auth-oidc-callback>`
- `DASHBOARD_OIDC_SCOPES=openid email profile`
- `REQUIRE_SHOP_ONBOARDING=true|false` (recomendado `true` en production)
- `ONBOARDING_SECRET=<shared-secret-para-onboarding>`
- `ALLOW_ONBOARDING_EMAIL_DOMAIN_BYPASS=true|false` (solo migraciones controladas)

Enterprise auth notes:

- `GET /auth/sso` permite puente SSO por cabeceras confiables (reverse-proxy / gateway de identidad).
- El bridge SSO falla en cerrado (`503`) si no hay secreto configurado (`DASHBOARD_SSO_HEADER_SECRET` o `DASHBOARD_SSO_JWT_SECRET`).
- `validateConfig()` tambien rechaza configuracion invalida cuando `DASHBOARD_SSO_ENABLED=true` y faltan ambos secretos.
- Si `DASHBOARD_SSO_HEADER_SECRET` esta configurado, se exige header `x-sso-secret`.
- Si llega `DASHBOARD_SSO_HEADER_JWT`, se valida firma HS256 y expiracion (`exp`) antes de crear sesion.
- `role` y `sites` en claims JWT pueden hacer downscope de la sesion cuando el usuario tiene permisos base para ello.
- `GET /auth/oidc/start` + `GET /auth/oidc/callback` implementan flujo OIDC nativo (authorization code), validando `state`/`nonce` e `id_token` (RS256 + JWKS) con `crypto` nativo de Node.
- Si no existe politica explicita en `DASHBOARD_ACCESS_POLICIES`, se usa fallback de `ADMIN_EMAILS` con rol `admin`.
- Tambien puedes persistir politicas de acceso en DB (modelo `DashboardAccessPolicy`) y gestionarlas desde Dashboard V2.

Consent API notes:

- `POST /consent-events` valida `country` como codigo de 2 letras (ISO-like); si falta, usa `DEFAULT_COUNTRY_CODE`.
- `GET /consent-events` y `GET /consent-events/export.csv` aplican ventana de historial por plan (`historyDays`).
- Las API credentials guardan solo hash SHA-256 del secreto en DB; la key en claro se muestra una sola vez al crear/regenerar.
- `POST /consent-events` soporta `subjectId` opcional (3-128 chars) para operaciones de privacidad por sujeto.

Privacy API notes:

- `GET /privacy/subjects/:subjectId/data?site=<site>` (scope `read`)
- `GET /privacy/subjects/:subjectId/export.csv?site=<site>` (scope `export`)
- `DELETE /privacy/subjects/:subjectId?site=<site>` (scope `export`)

Onboarding and customer portal:

- `POST /onboarding/register` crea shop, policy de acceso (`customer_owner`) y credencial inicial.
- `GET /onboarding/status?site=<site>` valida estado de onboarding y salud de plugin (eventos ultimas 24h).
- `GET /customer-portal` portal self-service para dueños (uso mensual, plan y gestion de credenciales por sitio).

Go-to-market minimum:

- Landing publica: `GET /`
- Registro self-service: `POST /signup` (crea cuenta/sitio y envia credenciales por email si hay provider)
- Guia de plugin: `GET /docs/plugin-install` y archivo `docs/plugin-install.md`
- Canal de soporte: variable `SUPPORT_EMAIL`

## Prometheus Alerts

Baseline alert rules are included in `ops/prometheus/alerts.rules.yml`:

- `ConsentHubHigh5xxRate`
- `ConsentHubDashboardRateLimited`
- `ConsentHubReadyzUnavailable`
- `ConsentHubHighP95Latency`

Recording rules are included in `ops/prometheus/recording.rules.yml`:

- `consenthub:http_requests:rate5m`
- `consenthub:http_5xx_requests:rate5m`
- `consenthub:http_5xx_ratio:rate5m`
- `consenthub:dashboard_rate_limit_rejections:rate5m`
- `consenthub:readyz_503:rate5m`
- `consenthub:http_latency_p95_ms:5m`

A scrape/rules bootstrap example is included in `ops/prometheus/prometheus.example.yml`.
Load `recording.rules.yml` before `alerts.rules.yml` in Prometheus.
Incident response playbook is documented in `ops/observability-runbook.md`.
Postmortem template and incident workflow docs are in `ops/incidents/`.
Stripe billing webhook behavior matrix (event -> expected action -> test coverage) is documented in `ops/stripe-webhook-event-matrix.md`.
Enterprise auth rollout and operations checklist is documented in `ops/enterprise-auth-runbook.md`.

## Grafana Dashboard

A baseline Grafana dashboard is included in `ops/grafana/consenthub-overview.dashboard.json`.

It visualizes:

- 5xx ratio (5m)
- total request rate (5m)
- global HTTP p95 latency (5m)
- `/readyz` 503 rate
- request rate vs 5xx trend
- top routes by request rate

Provisioning examples are included in:

- `ops/grafana/provisioning/datasources/prometheus.yml`
- `ops/grafana/provisioning/dashboards/consenthub.yml`

Expected container paths:

- dashboards JSON: `/var/lib/grafana/dashboards`
- datasource provisioning: `/etc/grafana/provisioning/datasources`
- dashboard provisioning: `/etc/grafana/provisioning/dashboards`

## Local Observability Stack

`docker-compose.yml` includes local services for PostgreSQL, Prometheus, and Grafana.

Start stack:

```bash
docker compose up -d
```

Access:

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000` (default admin/admin unless overridden)

Notes:

- Prometheus local config is `ops/prometheus/prometheus.local.yml`.
- Local scrape target expects ConsentHub API running on host at `http://localhost:8787`.
- In Docker, host is reached via `host.docker.internal` (configured with `host-gateway`).

When audit rate-limit variables are omitted, defaults are environment-aware:

- production: `10` requests per `60s`
- development/test: `60` requests per `60s`

## Smoke Validation

Run role and health smoke checks locally:

```bash
npm run smoke:roles
```

This validates role gating and probes:

- role behavior in `src/server.js` and `src/worker.js`
- `GET /livez`
- `GET /readyz`
- `GET /health`

Observability smoke validation (requires Prometheus running locally on `:9090`):

```bash
npm run smoke:observability
```

This validates:

- `/metrics` exposition in API process
- Prometheus readiness (`/-/ready`)
- key recording rule queries (`consenthub:http_requests:rate5m`, `consenthub:http_5xx_ratio:rate5m`, `consenthub:http_latency_p95_ms:5m`)

Run all local observability checks in one command (starts compose stack, waits for readiness, then runs both smokes):

```bash
npm run dev:observability
```

Additional helper:

```bash
npm run smoke:all
```

DB resilience helpers:

- `npm run db:backup`
- `npm run db:restore -- <file.dump|file.dump.enc>`
- `npm run db:drill`
- `npm run db:cross-restore` (backup + restore check in isolated temporary PostgreSQL container)
- `npm run db:offsite-cloud-smoke` (smoke real contra offsite cloud S3)
- `npm run db:migrate:deploy` (aplica migraciones Prisma en entornos de despliegue)
- `npm run db:security-policy` (policy-as-code de secretos/rotacion para backups)

Smoke real CI de backup/restore:

- `.github/workflows/db-drill.yml` ahora corre semanal, manual y tambien en push/PR cuando cambian scripts/tests de resiliencia DB.
- `.github/workflows/db-offsite-cloud-smoke.yml` ejecuta smoke real contra offsite cloud (S3) en schedule/manual con secretos de CI.

Hardening de secretos para backups/offsite:

- `STRICT_BACKUP_SECRETS=true` exige passphrase de cifrado, longitud minima y `BACKUP_ENCRYPTION_KEY_ID` para auditoria.
- `REQUIRE_ENCRYPTED_OFFSITE=true` bloquea copias offsite si no se habilita cifrado.
- `backup-security-policy.sh` valida en CI rotacion de llave con `BACKUP_ENCRYPTION_KEY_ROTATED_AT` y `BACKUP_KEY_MAX_AGE_DAYS`.

Secrets esperados para workflow cloud smoke (`db-offsite-cloud-smoke.yml`):

- `OFFSITE_SMOKE_URI`
- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `BACKUP_ENCRYPTION_PASSPHRASE`
- `BACKUP_ENCRYPTION_KEY_ID`

Nota de rollout enterprise:

- Para habilitar politicas persistentes de acceso dashboard (`DashboardAccessPolicy`), aplica migraciones antes del rollout de app.
- Si la tabla aun no existe, auth usa fallback a politicas en variables de entorno para evitar corte de login.

Pre-push observability verification (rules + focused tests + role smoke):

```bash
npm run verify:observability
```

Enterprise auth verification (OIDC/SSO bridge/session/config):

```bash
npm run verify:auth-enterprise
```

CI workflow dedicado:

- `.github/workflows/auth-enterprise.yml`

Prometheus-only validation:

```bash
npm run validate:prometheus
```

Performance budget check (latency/error baseline):

```bash
npm run perf:budget
```

Environment knobs:

- `PERF_BASE_URL` (default `http://127.0.0.1:8787`)
- `PERF_ENDPOINTS` (default `/livez,/readyz`)
- `PERF_SCENARIOS_JSON` (optional JSON array of scenarios with `method`, `path`, `headers`, `body`, `expectedStatus`)
- `PERF_SCENARIO_BUDGETS_JSON` (optional JSON array with per-scenario budgets: `method`, `path`, `p95Ms`, `errorRate`)
- `PERF_REQUESTS_TOTAL` (default `200`)
- `PERF_CONCURRENCY` (default `20`)
- `PERF_P95_MS_BUDGET` (default `250`)
- `PERF_ERROR_RATE_BUDGET` (default `0.01`)

Example with business endpoint load:

```bash
PERF_SCENARIOS_JSON='[{"method":"GET","path":"/livez"},{"method":"POST","path":"/consent-events","expectedStatus":201,"headers":{"x-api-key":"dev-key-change-me"},"body":{"site":"perf.local","category":"all","action":"accept_all","country":"CL"}},{"method":"GET","path":"/consent-events?site=perf.local","expectedStatus":200,"headers":{"x-api-key":"dev-key-change-me"}},{"method":"GET","path":"/shops","expectedStatus":200,"headers":{"x-api-key":"dev-key-change-me"}}]' npm run perf:budget
```

Example with per-scenario SLA budgets:

```bash
PERF_SCENARIOS_JSON='[{"method":"GET","path":"/livez"},{"method":"GET","path":"/readyz"},{"method":"POST","path":"/consent-events","expectedStatus":201,"headers":{"x-api-key":"dev-key-change-me"},"body":{"site":"perf.local","category":"all","action":"accept_all","country":"CL"}}]' \
PERF_SCENARIO_BUDGETS_JSON='[{"method":"GET","path":"/livez","p95Ms":200,"errorRate":0},{"method":"GET","path":"/readyz","p95Ms":250,"errorRate":0},{"method":"POST","path":"/consent-events","p95Ms":500,"errorRate":0.01}]' \
npm run perf:budget
```

Weekly CI performance budget workflow:

- `.github/workflows/performance.yml`
- starts API in test mode and fails if p95/error budget is exceeded.

Roadmap status (operability stream):

- Done: liveness/readiness split, request-id tracing, persisted audit logs with pagination/export/rate-limit.
- Done: worker jobs runtime status + history endpoints (JSON/CSV, cursor, validation).
- Done: Prometheus metrics endpoint + histogram latency + alert and recording rules.
- Done: Grafana dashboard and provisioning files.
- Done: local compose observability stack + automated smoke wrapper.

## CI Observability Gate

GitHub Actions workflow: `.github/workflows/observability.yml`

It validates:

- Prometheus rule syntax (`promtool check rules`)
- Prometheus config syntax (`promtool check config`)
- focused observability tests (`tests/metrics.test.js`, `tests/rate-limit.test.js`, `tests/config-env.test.js`)
- role smoke script (`npm run smoke:roles`)

Integration smoke job (`integration-smoke`) runs on PR/push and can also be triggered manually (`workflow_dispatch`):

- `docker compose up` for local observability services
- `npm run smoke:observability`

Integration smoke now runs as CI gate on PR/main as `integration-smoke` job.

DB resilience workflows:

- `.github/workflows/db-drill.yml` (weekly drill)
- `.github/workflows/db-cross-env-restore.yml` (weekly isolated cross-env restore check)

## Schema Sync

After pulling changes that add persistence models (for example `AuditLog`), sync Prisma artifacts:

```bash
npm run prisma:generate
npm run db:push
```

## Data Resilience (Backups)

Database operation commands:

```bash
npm run db:backup
npm run db:prune
npm run db:verify-backup -- ops/backups/<file>.dump
FORCE=true npm run db:restore -- ops/backups/<file>.dump
npm run db:drill
```

Detailed procedure and safety notes:

- `ops/db-backup-restore-runbook.md`

Manual CI drill workflow:

- `.github/workflows/db-drill.yml` (run with `workflow_dispatch`)
