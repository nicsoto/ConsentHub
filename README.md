# ConsentHub (MVP inicial)

Monorepo inicial del producto:

- `apps/wordpress-plugin/consenthub-espanol`: plugin WordPress para banner y preferencias.
- `apps/saas`: API SaaS minima para registrar y exportar eventos de consentimiento.

## Estado actual

Esta version crea una base funcional para desarrollo:

- Banner de cookies con acciones `aceptar`, `rechazar`, `personalizar`.
- Guardado de preferencias en navegador.
- Envio de eventos al backend por API key.
- Backend con endpoints de health, listado y export CSV.
- Rate limiting basico en ingesta (`POST /consent-events`): 120 requests por minuto por IP.

## Higiene de repo

- Los volcados locales de codigo (`CODIGO_*.md`) no se versionan.
- `README.md` y documentacion operativa si se versionan.
- Configuracion de despliegue y entorno productivo vive en `apps/saas/`.

## Requisitos

- Node.js 20+
- PostgreSQL 14+
- WordPress local (ejemplo: LocalWP, Docker o instalacion manual)

Si no tienes PostgreSQL local configurado, puedes usar Docker Compose en `apps/saas/docker-compose.yml`.

## 1) Levantar backend SaaS

```bash
cd apps/saas
cp .env.example .env
npm install
docker compose up -d
npm run prisma:generate
npm run db:push
npm run dev
```

Roles de proceso (web/worker):

- `APP_ROLE=web`: sirve API/dashboard (sin jobs)
- `APP_ROLE=worker`: ejecuta jobs de retencion y billing-alerts (sin API)
- Scripts utiles:
   - `npm run dev` (web)
   - `npm run dev:worker` (worker)
   - `npm run start:web`
   - `npm run start:worker`

Si `db:push` falla con `P1000 Authentication failed`, ajusta `DATABASE_URL` en `.env`
con tus credenciales reales de PostgreSQL local.

Si usas Docker Compose con la configuracion incluida, `DATABASE_URL` por defecto ya es compatible.

API disponible en `http://localhost:8787`.

Dashboard minimo disponible en:

`http://localhost:8787/dashboard`

El dashboard ahora usa autenticacion por magic link:

1. Entra a `http://localhost:8787/auth/login`
2. Usa un email incluido en `ADMIN_EMAILS`
3. En desarrollo, el enlace se imprime en consola y tambien aparece en pantalla
4. Abre el link y entra al dashboard con sesion por cookie

Para envio real de email configura en `.env`:

- `RESEND_API_KEY`
- `EMAIL_FROM` (dominio validado en Resend)

Comportamiento actual:

- En desarrollo, si falta config de email, el magic link se muestra en pantalla y consola.
- En produccion, si falta config de email, el login falla para evitar accesos inseguros.
- Solicitud de magic link protegida con rate limit (20 requests cada 10 minutos por IP).
- Los tokens de magic link se persisten en base de datos (`MagicLinkToken`) para evitar perdida en reinicios.
- Los buckets de rate limiting se persisten en base de datos (`RateLimitBucket`) para evitar reset por reinicio.
- Sesion de dashboard con renovacion automatica al acercarse al vencimiento.
- Formularios web protegidos con CSRF token firmado (auth y dashboard).

Validaciones de arranque (fail-fast):

- `API_KEYS` o `API_SITE_KEYS` obligatorio
- `ADMIN_EMAILS` obligatorio
- En produccion: `SESSION_SECRET` fuerte y `SECURE_COOKIES=true`

Opciones de seguridad de API:

- `API_KEYS`: llaves legacy con acceso completo (uso transitorio)
- `API_SITE_KEYS`: llaves con alcance por sitio. Formato: `key|site|scope1,scope2;key2|site2|scope1`
- Scopes soportados: `ingest`, `read`, `export`, `shops`
- Produccion recomendada: guardar credenciales scopeadas en DB (`ApiCredential`) y dejar `API_SITE_KEYS` solo como fallback temporal.
- `CORS_ALLOWED_ORIGINS`: lista de orígenes permitidos en producción para llamadas desde navegador

Gestion de credenciales en dashboard:

- Seccion "Credenciales API" por sitio en `/dashboard`
- Perfiles al crear: `ingest`, `read_export`, `full`
- La clave completa se muestra una sola vez al crear
- En dashboard se muestra enmascarada y permite revocacion
- Boton para regenerar `ingest`: revoca claves antiguas de ingesta del sitio y emite una nueva
- Recomendado para plugin WordPress: perfil `ingest` (minimo privilegio)

Funciones actuales del dashboard:

- Filtro por sitio
- Filtro por ventana de tiempo (1, 7, 30, 90 dias)
- Limite de eventos recientes
- KPIs por accion de consentimiento (aceptar, rechazar, personalizar)
- Desglose por categoria con porcentaje
- Configuracion de retencion de logs por sitio
- Ejecucion manual de limpieza de retencion
- Estado de plan por sitio (`free`, `starter`, `pro`)
- Uso mensual por sitio (ultimos 30 dias) vs limite del plan
- KPI de sitios en riesgo (`past_due` con gracia activa)
- Seccion de incidentes recientes con MTTR de 30 dias
- Export de incidentes (`/dashboard/incidents/export` y `/dashboard/incidents/export.csv`)
- Botones de checkout Stripe por sitio (Starter/Pro)
- Boton de portal de cliente Stripe por sitio
- Upgrade mock en desarrollo para pruebas rapidas
- Gestion de credenciales API por sitio (crear/revocar) con scopes

Billing (MVP inicial):

- Endpoint de checkout: `POST /billing/checkout` (requiere sesion + CSRF)
- Endpoint de estado por sitio: `GET /billing/status?site=...` (requiere sesion)
- Endpoint webhook Stripe: `POST /billing/webhook` (firma Stripe)
- Endpoint portal cliente: `POST /billing/portal` (requiere sesion + CSRF)

Idempotencia de webhook:

- Los eventos Stripe procesados se registran y no se reprocesan si llegan duplicados.
- Modelo: `BillingWebhookEvent` (clave unica `provider + eventId`).

Alertas operativas de cobro:

- En `invoice.payment_failed`, ademas de pasar a `past_due`, se crea una alerta abierta en dashboard.
- El dashboard permite marcar alertas como resueltas para seguimiento de soporte.
- El dashboard permite ejecutar una revision manual de alertas vencidas (escalado a critico).
- Modelo: `BillingAlert`.
- Cuando se escalan alertas a critico, se intenta notificar por email a `ADMIN_EMAILS`.

Job de escalado de alertas:

- Servicio: `src/services/billingAlertJob.js`
- Frecuencia configurable con `BILLING_ALERT_JOB_MINUTES` (default 1440, diario)
- Cooldown de notificacion configurable con `BILLING_CRITICAL_EMAIL_COOLDOWN_MINUTES` (default 180)
- Escala alertas `payment_failed` a severidad `critical` cuando la gracia ya vencio.
- Si hay alertas nuevas en critico, envia resumen por email usando Resend (`RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_EMAILS`).
- El cooldown se aplica por combinacion `sitio + tipo` para evitar spam de correos repetidos en ventanas cortas.

Health endpoint:

- `GET /health` ahora expone `role`, `jobsInThisProcess` y `webInThisProcess`.

Limites por plan (enforced en API):

- `free`: hasta 1000 eventos/30 dias por sitio, sin export CSV
- `starter`: hasta 20000 eventos/30 dias por sitio, con export CSV
- `pro`: hasta 200000 eventos/30 dias por sitio, con export CSV

Plan efectivo (segun estado de cobro):

- `active`/`trialing`: se aplica el plan contratado.
- `past_due` con gracia vigente: se mantiene el plan contratado temporalmente.
- `past_due` con gracia vencida: se aplica `free`.
- `canceled`/`unpaid`/`incomplete_expired`: se aplica `free`.

Respuestas de limite:

- `POST /consent-events` devuelve `402` cuando se supera el limite mensual del plan.
- `GET /consent-events/export.csv` devuelve `402` en plan `free`.

Downgrade automatico de plan:

- En `customer.subscription.deleted`, el sitio baja a `free` con estado `canceled`.
- En `invoice.payment_failed`, el sitio pasa a `past_due` y entra a periodo de gracia configurable (`BILLING_GRACE_DAYS`).

Variable de gracia:

- `BILLING_GRACE_DAYS` (default 7)

Variable de cooldown para alertas criticas:

- `BILLING_CRITICAL_EMAIL_COOLDOWN_MINUTES` (default 180)

Variables nuevas para Stripe en `.env`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_PRO`

Si faltan estas variables, el dashboard mantiene flujo normal y muestra aviso de configuracion al intentar checkout.

Nota de datos:

- El estado de billing ahora se persiste en el modelo `Shop` (campos `plan`, `billingStatus`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`).
- El estado de billing ahora se persiste en el modelo `Shop` (campos `plan`, `billingStatus`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`, `gracePeriodEndsAt`).
- El modelo `BillingAlert` ahora guarda `lastCriticalEmailAt` para throttling de notificaciones criticas.
- Tras actualizar codigo, ejecuta `npm run prisma:generate` y `npm run db:push` en `apps/saas` para aplicar el esquema local.

Si ya tienes una base existente y quieres migraciones versionadas, usa:

```bash
npm run db:migrate
```

Tests automaticos (auth/CSRF/health):

```bash
cd apps/saas
npm test
```

Nota: los tests ejecutan con `USE_IN_MEMORY_STORE=true`, por lo que validan flujos de API
sin depender de PostgreSQL local para la capa de pruebas.

Cobertura actual de tests:

- `GET /health`
- `POST /auth/request-link` con y sin CSRF
- `GET /auth/verify` (token valido/invalido)
- redirect de `/dashboard` sin sesion
- dashboard autenticado con filtros
- `POST /dashboard/retention` con y sin CSRF
- export de incidentes del dashboard en JSON y CSV
- validaciones de `POST /consent-events` (auth + payload)
- flujo completo consent (`create -> list -> export.csv -> shops`)

CI:

- Workflow: `.github/workflows/saas-tests.yml`
- Corre `npm test` en push y pull request para cambios en `apps/saas`

## 2) Instalar plugin en WordPress

1. Copia `apps/wordpress-plugin/consenthub-espanol` a `wp-content/plugins/`.
2. Activa el plugin en el admin de WordPress.
3. Ve a `Ajustes -> ConsentHub`.
4. Completa:
   - URL API: `http://localhost:8787/consent-events`
   - API Key: igual a `API_KEYS` en `.env`
   - ID del sitio: por defecto el dominio

Flujo seguro del plugin:

- El JS del frontend no envía la API key al backend SaaS.
- El plugin envía eventos a un endpoint proxy server-side de WordPress (`admin-ajax.php?action=consenthub_track_event`).
- Ese endpoint reenvía al SaaS con la API key guardada en opciones del plugin.
- Recomendado: usar una credencial scopeada `ingest` por sitio (mínimo privilegio).

## 3) Probar flujo end-to-end

1. Abre el sitio en frontend.
2. Interactua con el banner.
3. Verifica eventos:

```bash
curl -H 'x-api-key: dev-key-change-me' 'http://localhost:8787/consent-events?site=tu-dominio.local'
```

4. Export CSV:

```bash
curl -H 'x-api-key: dev-key-change-me' 'http://localhost:8787/consent-events/export.csv?site=tu-dominio.local'
```

Nota: los endpoints API de eventos y export usan API key solo por header `x-api-key`.

## Siguientes hitos

- Dashboard frontend separado (no SSR en string) para evolucion de UX.
- Refinar capacidades enterprise: SSO/RBAC avanzado y multi-tenant admin.
- Performance budgets por endpoint y pruebas de carga periodicas.
- Expandir resiliencia de datos (retencion offsite/cifrado y drills de restauracion cruzada).

Nota: gran parte del hardening operativo ya fue implementado en `apps/saas` (observabilidad, CI gates, runbooks, backup/restore/drill).

## Nota legal

ConsentHub facilita implementacion tecnica y buenas practicas. No constituye asesoria legal.
