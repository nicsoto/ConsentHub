# ConsentHub

ConsentHub helps ecommerce teams collect, audit, and export consent events without slowing down checkout or product delivery.

## What Problem It Solves

If you run stores in LATAM/EU, you need proof of consent decisions, quick exports for audits, and operational control over plan limits and billing states.

ConsentHub gives you:

- Server-to-server consent ingestion with scoped credentials.
- Customer-facing portal for usage and credential management.
- Billing-aware plan enforcement (limits, grace period, downgrade behavior).
- Privacy endpoints for subject data access/export/deletion.

## Who It Is For

- Ecommerce teams on WordPress.
- Agencies managing multiple stores.
- SaaS operators who need a consent backend with billing and ops controls.

## Product Snapshot

### Dashboard

![Dashboard V2](apps/saas/docs/media/dashboard-v2.svg)

### WordPress Plugin Setup

![Plugin Settings](apps/saas/docs/media/plugin-settings.svg)

### Signup to Activation Flow

![Flow](apps/saas/docs/media/signup-flow.svg)

## Install in 5 Minutes

1. Start backend:

```bash
cd apps/saas
cp .env.example .env
npm install
docker compose up -d
npm run prisma:generate
npm run db:push
npm run dev
```

2. Open the product landing at `http://localhost:8787/`.
3. Create a customer via signup (`/signup`) or onboarding API.
4. Install plugin from `apps/wordpress-plugin/consenthub-espanol` in WordPress.
5. Follow plugin docs at `http://localhost:8787/docs/plugin-install`.

## Core URLs

- Public landing: `/`
- Public signup: `POST /signup`
- Plugin install docs: `/docs/plugin-install`
- Customer login: `/auth/login`
- Customer portal: `/customer-portal`
- Dashboard V2 (admin): `/dashboard-v2`

## Repository Structure

- `apps/saas`: SaaS backend (API, auth, dashboard, billing, onboarding).
- `apps/wordpress-plugin/consenthub-espanol`: WordPress plugin.
- `apps/saas/docs`: operational and deployment docs.

## Deployment

- Render blueprint: `apps/saas/render.yaml`
- Deploy guide: `apps/saas/docs/deploy-render.md`
- Production env validation: `cd apps/saas && npm run verify:prod-env`

## Current Capabilities

- WordPress plugin sends events through a server-side proxy flow.
- No browser-exposed API key requirement in the default integration path.
- Scoped API credentials stored hashed at rest.
- Magic-link auth with CSRF-protected web actions.
- Optional SSO bridge and native OIDC login.
- Stripe checkout/webhook/portal integration.
- Billing alerts, escalation, and incident exports.
- Privacy endpoints for subject-level requests.
- Onboarding endpoints and customer portal flows.

## Roadmap (Near Term)

- Publish real product screenshots/GIF from live environment.
- Add public docs site (FAQ + troubleshooting + integrations).
- Add DNS domain verification for onboarding trust.

## Release

- Latest release notes: `apps/saas/RELEASE_NOTES.md`

## License

Proprietary for now (update when distribution policy is finalized).
