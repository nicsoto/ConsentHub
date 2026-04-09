# Onboarding del Plugin ConsentHub

Esta guia cubre la instalacion minima para que tu sitio empiece a enviar eventos de consentimiento.

## 1) Registro y credenciales

1. Entra a la landing publica (`/`) y completa el formulario de registro.
2. Recibiras por email una API key inicial (o se mostrara una sola vez como fallback).
3. Guarda la API key en un gestor seguro.

## 2) Instalar plugin en WordPress

1. Sube el paquete zip del plugin desde `Plugins > Anadir nuevo > Subir plugin`.
2. Activa el plugin.

## 3) Configuracion minima del plugin

- `Site`: dominio registrado (ejemplo: `tienda.tu-dominio.com`)
- `API Key`: clave de onboarding (`ch_ing_...`)
- `API Base URL`: URL base del SaaS (ejemplo: `https://api.tu-dominio.com`)

## 4) Verificacion de funcionamiento

1. Genera al menos un evento de consentimiento desde tu web.
2. Verifica estado en `GET /onboarding/status?site=<tu-site>`.
3. Si `pluginHealthy=true`, el flujo esta operativo.

## 5) Portal de cliente

1. Solicita magic link en `/auth/login` con el email propietario.
2. Accede a `/customer-portal` para:
   - revisar uso mensual,
   - revisar plan,
   - crear/revocar credenciales.

## 6) Privacidad (Ley 21.719 / GDPR)

Con API key de alcance correcto:

- `GET /privacy/subjects/:subjectId/data?site=<site>`
- `GET /privacy/subjects/:subjectId/export.csv?site=<site>`
- `DELETE /privacy/subjects/:subjectId?site=<site>`

## 7) Soporte

Canal recomendado: email de soporte configurado en `SUPPORT_EMAIL`.
