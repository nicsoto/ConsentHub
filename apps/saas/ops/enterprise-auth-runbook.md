# Enterprise Auth Runbook

## Objetivo

Estandarizar rollout y operacion de autenticacion enterprise en ConsentHub Dashboard:

- Bridge SSO por cabeceras/JWT (`/auth/sso`)
- OIDC nativo (authorization code) (`/auth/oidc/start`, `/auth/oidc/callback`)
- RBAC y alcance multi-tenant (`role`, `sites`)

## Requisitos previos

- Migraciones aplicadas (`npm run db:migrate:deploy`)
- Politicas de acceso disponibles en DB (`DashboardAccessPolicy`) o fallback via `DASHBOARD_ACCESS_POLICIES`
- `SESSION_SECRET` fuerte y `SECURE_COOKIES=true` en produccion
- Politica de backup segura en produccion: `STRICT_BACKUP_SECRETS=true` y `REQUIRE_ENCRYPTED_OFFSITE=true`

## Configuracion recomendada

### OIDC nativo

Variables minimas:

- `DASHBOARD_OIDC_ENABLED=true`
- `DASHBOARD_OIDC_ISSUER=https://idp.empresa.com`
- `DASHBOARD_OIDC_CLIENT_ID=<client-id>`
- `DASHBOARD_OIDC_CLIENT_SECRET=<client-secret>`

Opcionales:

- `DASHBOARD_OIDC_DISCOVERY_URL=<issuer-override>`
- `DASHBOARD_OIDC_REDIRECT_URI=<override-callback>`
- `DASHBOARD_OIDC_SCOPES=openid email profile`

### Bridge SSO

- `DASHBOARD_SSO_ENABLED=true`
- `DASHBOARD_SSO_HEADER_SECRET=<shared-secret-opcional>`
- `DASHBOARD_SSO_HEADER_JWT=x-sso-jwt`
- `DASHBOARD_SSO_JWT_SECRET=<hs256-secret-opcional>`

## Checklist de rollout por entorno

1. Desarrollo:
- Confirmar login magic link funcional
- Confirmar `GET /auth/oidc/start` redirige a IdP
- Confirmar callback OIDC crea sesion y redirige a `/dashboard-v2`

2. Staging:
- Validar claims de email desde IdP real
- Verificar asignacion de acceso por politica (`role`, `sites`)
- Verificar denegacion para usuarios sin politica activa

3. Produccion:
- Rotar `SESSION_SECRET` y secretos OIDC/SSO en vault
- Confirmar `SECURE_COOKIES=true`
- Monitorear intentos fallidos en logs (`oidc callback failed`, `JWT SSO invalido`)

## Validaciones funcionales

### Flujo OIDC exitoso

1. Navegar a `/auth/oidc/start`
2. Completar login en IdP
3. Verificar redireccion final a `/dashboard-v2`
4. Verificar cookie `consenthub_session`

### Flujo de rechazo esperado

- `state` invalido en callback debe retornar `401`
- `id_token` invalido/firma incorrecta debe retornar `401`
- Usuario sin politica debe retornar `403`

## Operacion RBAC y multi-tenant

- `admin`: acceso completo
- `operator`: operaciones operativas segun permisos
- `billing_manager`: operaciones de billing
- `analyst`: lectura y analitica

Validar que `sites` limita operaciones de escritura por tenant.

## Onboarding / Offboarding

Onboarding:

1. Crear politica de acceso via dashboard-v2 o DB
2. Confirmar login y alcance por sitio
3. Registrar evidencia de acceso en ticket interno

Offboarding:

1. Desactivar/eliminar politica de acceso
2. Invalidar sesiones activas (rotacion de secreto en caso critico)
3. Confirmar denegacion de login

## Incidentes comunes

- Error `OIDC token exchange fallido`: revisar client secret, redirect URI y conectividad a token endpoint.
- Error `OIDC id_token invalido`: revisar issuer/audience, `kid` y JWKS vigente.
- Error `JWT SSO invalido`: revisar secreto HS256 y expiracion del token.

## Post-rollout

- Ejecutar suite de auth y config en CI:
  - `node --test tests/auth-session.test.js tests/config-env.test.js`
- Actualizar `TICKETS_ESTADO.md` y `IMPLEMENTACION_Y_ESTADO.md` con fecha de cierre.
