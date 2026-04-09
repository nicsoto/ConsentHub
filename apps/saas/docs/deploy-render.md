# Deploy en Render (Web + Worker)

Este proyecto ya esta listo para desplegar con blueprint en Render usando `render.yaml`.

## Lo que puedes automatizar desde repo

- Blueprint de Render: `render.yaml`
- Script de validacion de env: `scripts/check-production-env.js`

## Lo que tienes que hacer tu (obligatorio)

1. Crear cuenta en Render.
2. Conectar tu repositorio GitHub.
3. Crear cuenta en Stripe y Resend.
4. Configurar dominio y DNS.
5. Cargar secretos reales (no se pueden guardar en repo).

## Pasos

1. En Render, usa **New + > Blueprint** y selecciona el repo.
2. Render detectara `render.yaml` y creara:
   - `consenthub-web`
   - `consenthub-worker`
   - `consenthub-postgres`
3. En ambos servicios, configura variables faltantes:
   - `APP_BASE_URL=https://api.tudominio.com`
   - `CORS_ALLOWED_ORIGINS=https://tudominio.com,https://www.tudominio.com`
   - `SESSION_SECRET=<random-largo>`
   - `ONBOARDING_SECRET=<random-largo>`
   - `STRIPE_SECRET_KEY=<stripe-secret>`
   - `STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret>`
   - `STRIPE_PRICE_STARTER=<price_id>`
   - `STRIPE_PRICE_PRO=<price_id>`
   - `RESEND_API_KEY=<resend-key>`
   - `EMAIL_FROM=ConsentHub <noreply@tu-dominio.com>`
   - `SUPPORT_EMAIL=soporte@tu-dominio.com`
   - `METRICS_BEARER_TOKEN=<token-largo>`
4. Configura dominio custom para `consenthub-web`.
5. En Stripe, agrega webhook a:
   - `https://api.tudominio.com/billing/webhook`
6. Verifica endpoints:
   - `/livez`
   - `/readyz`
   - `/`
   - `/docs/plugin-install`

## Validacion previa (local o CI)

Ejecuta:

```bash
NODE_ENV=production \
SECURE_COOKIES=true \
ALLOW_LEGACY_API_KEYS=false \
REQUIRE_SHOP_ONBOARDING=true \
ALLOW_ONBOARDING_EMAIL_DOMAIN_BYPASS=false \
DATABASE_URL=postgresql://... \
APP_BASE_URL=https://api.tudominio.com \
SESSION_SECRET=... \
ONBOARDING_SECRET=... \
STRIPE_SECRET_KEY=... \
STRIPE_WEBHOOK_SECRET=... \
STRIPE_PRICE_STARTER=... \
STRIPE_PRICE_PRO=... \
RESEND_API_KEY=... \
EMAIL_FROM='ConsentHub <noreply@tu-dominio.com>' \
SUPPORT_EMAIL=soporte@tu-dominio.com \
METRICS_BEARER_TOKEN=... \
node scripts/check-production-env.js
```

Si el script falla, corrige variables antes de publicar.
