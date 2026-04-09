# ConsentHub - Tickets y Estado

Fecha de corte: 2026-04-08

## DONE

- CH-OPS-001: Health split y readiness real (`/livez`, `/readyz`, `/health`)
- CH-OPS-002: Request ID y logging estructurado
- CH-OPS-003: Auditoria persistida + cursor + CSV + rate limit
- CH-OBS-001: Endpoint Prometheus + metricas HTTP/latencia/rate-limit
- CH-OBS-002: Alertas + recording rules
- CH-OBS-003: Dashboard Grafana + provisioning
- CH-CI-001: Gate de observabilidad en CI
- CH-OPS-004: Runbooks + incident/postmortem templates
- CH-DR-001: Backup/restore/drill con checksum
- CH-DR-002: CI semanal de db-drill
  - Hecho: trigger adicional push/PR cuando cambian scripts/tests DB para smoke real continuo en contenedores
- CH-DR-004: Tests automatizados para scripts DB (verify/backup/prune/restore/drill con mocks)
- CH-DR-003: Backups enterprise (cifrado/offsite opcional + check cross-env automatizado)
  - Hecho: guardrails de secretos/offsite en `db-backup.sh` (`STRICT_BACKUP_SECRETS`, `REQUIRE_ENCRYPTED_OFFSITE`, `BACKUP_ENCRYPTION_KEY_ID`) con cobertura en tests
  - Hecho: smoke offsite cloud real en CI (`apps/saas/.github/workflows/db-offsite-cloud-smoke.yml`)
  - Hecho: policy-as-code de secretos/rotacion en CI (`apps/saas/scripts/backup-security-policy.sh` + `apps/saas/.github/workflows/backup-security-policy.yml`)
- CH-AUTH-001: Politica de legacy API keys
  - Hecho: enforcement explicito de ownership por sitio para keys scoped/db-scoped en `/consent-events` (403 en mismatch)
- CH-BILL-001: Idempotencia webhook + fallback de sitio
- CH-BILL-002: Transiciones billing robustas y edge cases
- CH-BILL-003: Recuperacion por pago exitoso y limpieza de gracia
- CH-BILL-004: Proteccion de out-of-order (no reactivar canceled)
- CH-BILL-005: Cierre automatico de alertas payment_failed al recuperar pago
- CH-BILL-006: Matriz formal Stripe evento -> comportamiento -> cobertura
- CH-PERF-001: Performance budgets + carga periodica
  - Hecho: baseline runner `scripts/perf-budget.js`
  - Hecho: workflow semanal `.github/workflows/performance.yml`
  - Hecho: escenarios mixtos operativos + negocio (`POST /consent-events`) con `PERF_SCENARIOS_JSON`
  - Hecho: budgets por escenario/ruta (`PERF_SCENARIO_BUDGETS_JSON`) para SLA granular
  - Hecho: enforcement de `historyDays` por plan en lectura/export de consent events
- CH-FE-001: Dashboard frontend separado
  - Hecho: nueva UI separada en archivos estaticos (`src/public/dashboard-v2/index.html`, `assets/styles.css`, `assets/app.js`)
  - Hecho: ruta protegida `GET /dashboard-v2` y endpoint JSON `GET /dashboard-v2/data`
  - Hecho: acciones mutables en V2 via JSON (`retencion`, `billing alerts`, `api-credentials`)
  - Hecho: optimizacion de carga en dashboard para evitar N+1 en uso mensual por sitio (agregacion batch)
- CH-ENT-001: SSO enterprise
  - Hecho: endpoint `GET /auth/sso` con cabeceras confiables (bridge reverse-proxy/IdP)
  - Hecho: controles de seguridad por `DASHBOARD_SSO_ENABLED` + `DASHBOARD_SSO_HEADER_SECRET`
  - Hecho: soporte JWT firmado (HS256) en `GET /auth/sso` con validacion de firma/exp (`DASHBOARD_SSO_HEADER_JWT`, `DASHBOARD_SSO_JWT_SECRET`)
  - Hecho: integracion OIDC nativa (authorization code) en `GET /auth/oidc/start` y `GET /auth/oidc/callback`
  - Hecho: validacion criptografica de `id_token` (RS256 + JWKS) con control `state`/`nonce`
  - Hecho: runbook de rollout/onboarding enterprise (`apps/saas/ops/enterprise-auth-runbook.md`)
  - Nota: SAML nativo se mantiene como decision opcional de plataforma; el bridge `/auth/sso` cubre integraciones IdP via gateway.
- CH-ENT-002: RBAC avanzado + admin multi-tenant
  - Hecho: sesiones con claims de `role` y `sites` (compatibles con formato legacy)
  - Hecho: permisos por rol en endpoints mutables de `dashboard-v2`
  - Hecho: enforcement de alcance por sitio para operaciones sensibles
  - Hecho: API/UI admin para gestionar politicas de acceso (`/dashboard-v2/access-policies`)
  - Hecho: migracion Prisma y script deploy para `DashboardAccessPolicy`
  - Hecho: hardening anti-bypass en rutas legacy (`/dashboard/*` y `/billing/*`) con RBAC/scope
  - Hecho: cobertura adicional de hardening auth/config (OIDC gating + validaciones de entorno)
  - Hecho: gate CI dedicado para auth enterprise (`apps/saas/.github/workflows/auth-enterprise.yml` + `npm run verify:auth-enterprise`)

## IN PROGRESS

## PENDIENTE

- Sin pendientes obligatorios en este stream (enterprise auth/rbac/perf/frontend separados ya cerrados).
- Nota de plataforma: SAML nativo queda como opcional segun requerimiento corporativo.
- Nota operativa: workflows cloud requieren secretos CI para ejecucion efectiva.

## Referencias de implementacion

- Estado ejecutivo: `IMPLEMENTACION_Y_ESTADO.md`
- Matriz Stripe: `apps/saas/ops/stripe-webhook-event-matrix.md`
- Billing webhook: `apps/saas/src/routes/billing.js`
- Tests billing webhook: `apps/saas/tests/billing-webhook-flow.test.js`
- Tests billing alerts: `apps/saas/tests/billing-alerts.test.js`
- Tests scripts DB: `apps/saas/tests/db-scripts.test.js`
- Baseline performance: `apps/saas/scripts/perf-budget.js`
