=== ConsentHub Espanol ===
Contributors: consenthub
Tags: cookies, consentimiento, privacidad, gdpr
Requires at least: 6.0
Tested up to: 6.5
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Banner de cookies y centro de preferencias para sitios WordPress en espanol.

== Description ==

ConsentHub Espanol agrega un banner de cookies y un panel de preferencias para categorias no esenciales.

Funciones iniciales:
- Aceptar todo
- Rechazar no esenciales
- Personalizar analitica y marketing
- Envio de eventos a API SaaS
- Bloqueo y activacion de scripts por categoria (analytics/marketing)
- Plantillas legales editables (cookies, privacidad y disclaimer)

Seguridad de eventos:
- El navegador no envia la API key directamente a ConsentHub SaaS.
- El plugin usa un endpoint proxy server-side en WordPress (`admin-ajax.php`) para reenviar eventos.
- Configura una API key con scope `ingest` para minimo privilegio.
- En el panel del plugin se muestra una advertencia si la API key no parece de tipo `ingest`.
- Puedes regenerar keys `ingest` por sitio desde el dashboard SaaS.

== Script Blocking ==

Para bloquear scripts no esenciales hasta obtener consentimiento, marca los scripts con `data-consenthub-category` y `type="text/plain"`.

Ejemplo analitica:
`<script type="text/plain" data-consenthub-category="analytics" src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>`

Ejemplo marketing:
`<script type="text/plain" data-consenthub-category="marketing" src="https://connect.facebook.net/en_US/fbevents.js"></script>`

Cuando el usuario concede consentimiento para esa categoria, ConsentHub reemplaza el script bloqueado por uno ejecutable.

== Installation ==

1. Sube la carpeta `consenthub-espanol` a `/wp-content/plugins/`.
2. Activa el plugin en WordPress.
3. Ve a Ajustes -> ConsentHub.
4. Configura URL API y API key.
5. Recomendado: usar una API key de solo ingesta (`ingest`) creada en el dashboard SaaS.
5. Revisa y adapta las plantillas legales en Ajustes -> ConsentHub.

== Changelog ==

= 0.1.0 =
- Version inicial MVP
