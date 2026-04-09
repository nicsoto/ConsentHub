const express = require("express");
const crypto = require("crypto");
const {
  appBaseUrl,
  supportEmail,
  allowOnboardingEmailDomainBypass,
} = require("../config/env");
const {
  findShopBySite,
  createShopOnboarding,
  createApiCredential,
  upsertDashboardAccessPolicy,
} = require("../data/store");
const { sendOnboardingWelcomeEmail } = require("../services/email");

const router = express.Router();
const SITE_PATTERN = /^[a-z0-9.-]{3,255}$/;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeSite(site) {
  return String(site || "").trim().toLowerCase();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePlan(plan) {
  const raw = String(plan || "starter").trim().toLowerCase();
  if (raw === "starter" || raw === "pro") {
    return raw;
  }
  return "starter";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidSite(site) {
  if (!site || !SITE_PATTERN.test(site)) {
    return false;
  }
  return !site.startsWith(".") && !site.endsWith(".") && !site.includes("..");
}

function ownerDomainMatchesSite(ownerEmail, site) {
  const domain = String(ownerEmail || "").split("@")[1] || "";
  if (!domain) {
    return false;
  }
  return site === domain || site.endsWith(`.${domain}`);
}

function generateIngestKey() {
  return `ch_ing_${crypto.randomBytes(20).toString("hex")}`;
}

function renderLanding() {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ConsentHub | Consentimiento y cumplimiento para ecommerce</title>
    <style>
      :root {
        --bg: #f5f1e8;
        --ink: #0f172a;
        --card: #fffdf8;
        --accent: #0f766e;
        --accent-2: #b45309;
        --muted: #475569;
        --line: #d6d3d1;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; color: var(--ink); background: radial-gradient(circle at 10% 10%, #fff5d8 0%, transparent 42%), radial-gradient(circle at 90% 20%, #d1fae5 0%, transparent 35%), var(--bg); }
      .wrap { width: min(1120px, 94vw); margin: 0 auto; }
      header { padding: 26px 0; display: flex; justify-content: space-between; align-items: center; }
      .brand { font-family: "Space Grotesk", "Segoe UI", sans-serif; font-weight: 700; letter-spacing: 0.04em; }
      .hero { padding: 30px 0 26px; display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 22px; }
      .panel { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      h1 { font-family: "Space Grotesk", "Segoe UI", sans-serif; font-size: clamp(30px, 5vw, 48px); line-height: 1.04; margin: 0 0 12px; }
      h2 { margin: 0 0 8px; font-size: 20px; }
      p { color: var(--muted); margin: 0 0 10px; }
      .cta { display: inline-block; margin-top: 8px; background: var(--accent); color: #fff; border: 0; border-radius: 10px; padding: 11px 14px; text-decoration: none; font-weight: 700; }
      .prices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 14px; }
      .price { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: #fff; }
      .price strong { font-size: 22px; color: var(--accent-2); }
      form { display: grid; gap: 8px; }
      label { font-size: 13px; color: var(--muted); }
      input, select { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 10px; font: inherit; background: #fff; }
      button { border: 0; border-radius: 10px; padding: 11px 14px; background: #111827; color: #fff; font-weight: 700; cursor: pointer; }
      .links { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
      .chip { font-size: 12px; padding: 6px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
      footer { padding: 22px 0 32px; color: var(--muted); font-size: 14px; }
      @media (max-width: 880px) {
        .hero { grid-template-columns: 1fr; }
        .prices { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <div class="brand">ConsentHub</div>
        <div class="chip">SaaS Consent Mode + evidencia legal</div>
      </header>

      <section class="hero">
        <article class="panel">
          <h1>Activa cumplimiento de consentimiento en dias, no meses.</h1>
          <p>Recolecta, exporta y audita señales de consentimiento por sitio. Diseñado para ecommerce que necesita demostrar cumplimiento sin frenar conversion.</p>
          <a class="cta" href="#signup">Empezar ahora</a>
          <div class="prices">
            <div class="price"><h2>Starter</h2><strong>$39 USD</strong><p>/mes · 20k eventos</p></div>
            <div class="price"><h2>Pro</h2><strong>$129 USD</strong><p>/mes · 200k eventos</p></div>
            <div class="price"><h2>Enterprise</h2><strong>Custom</strong><p>SSO/OIDC y SLA</p></div>
          </div>
          <div class="links">
            <a href="/docs/plugin-install" class="chip">Guia plugin</a>
            <a href="/auth/login" class="chip">Ingreso clientes</a>
            <span class="chip">Soporte: ${escapeHtml(supportEmail)}</span>
          </div>
        </article>

        <article class="panel" id="signup">
          <h2>Registro inmediato</h2>
          <p>Te creamos cuenta, sitio y API key inicial. Recibes credenciales por email.</p>
          <form method="post" action="/signup">
            <label>Email de propietario</label>
            <input name="ownerEmail" type="email" required placeholder="owner@tu-dominio.com" />
            <label>Dominio/sitio</label>
            <input name="site" required placeholder="tienda.tu-dominio.com" />
            <label>Plan</label>
            <select name="plan">
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
            </select>
            <label>Pais</label>
            <input name="country" value="CL" maxlength="2" />
            <button type="submit">Crear cuenta y enviar credenciales</button>
          </form>
        </article>
      </section>

      <footer>
        <strong>Canal de soporte:</strong> ${escapeHtml(supportEmail)} · Respuesta objetivo: 24h habiles
      </footer>
    </div>
  </body>
</html>`;
}

function renderSignupResult(input = {}) {
  const ok = Boolean(input.ok);
  const title = ok ? "Cuenta creada" : "No se pudo completar registro";
  const hint = String(input.hint || "");
  const secretBlock = input.apiKey
    ? `<p style="padding:10px; border:1px solid #d1d5db; border-radius:10px; background:#f8fafc;"><strong>API Key:</strong> ${escapeHtml(input.apiKey)}</p>`
    : "";

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; background: #f8fafc; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; color: #0f172a; }
      .box { width: min(740px, 94vw); margin: 38px auto; padding: 22px; border: 1px solid #dbeafe; border-radius: 14px; background: #fff; }
      a { color: #0f766e; }
      .ok { color: #166534; }
      .err { color: #b91c1c; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1 class="${ok ? "ok" : "err"}">${escapeHtml(title)}</h1>
      <p>${escapeHtml(hint)}</p>
      ${secretBlock}
      <p><a href="/">Volver al inicio</a> · <a href="/docs/plugin-install">Ver onboarding de plugin</a></p>
      <p>Soporte: ${escapeHtml(supportEmail)}</p>
    </div>
  </body>
</html>`;
}

router.get("/", (_req, res) => {
  return res.status(200).send(renderLanding());
});

router.get("/docs/plugin-install", (_req, res) => {
  return res.status(200).send(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Guia plugin ConsentHub</title>
    <style>
      body { margin: 0; background: #f8fafc; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; color: #0f172a; }
      .wrap { width: min(860px, 94vw); margin: 28px auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; }
      code { background: #f1f5f9; padding: 2px 5px; border-radius: 6px; }
      ol { line-height: 1.7; }
      a { color: #0f766e; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Instalacion del plugin (onboarding rapido)</h1>
      <ol>
        <li>Registra tu cuenta en <a href="${escapeHtml(appBaseUrl)}">${escapeHtml(appBaseUrl)}</a> y guarda la <code>API key</code>.</li>
        <li>En WordPress, instala el plugin de ConsentHub desde el zip entregado.</li>
        <li>Configura <code>Site</code> igual al dominio registrado (ej: <code>tienda.tu-dominio.com</code>).</li>
        <li>Pega la <code>API key</code> y guarda cambios.</li>
        <li>Ejecuta prueba de consentimiento en tu web y confirma en <code>/onboarding/status?site=...</code> que <code>pluginHealthy=true</code>.</li>
        <li>Ingresa en <a href="/auth/login">/auth/login</a> para revisar uso y gestionar credenciales.</li>
      </ol>
      <p>Soporte: ${escapeHtml(supportEmail)}</p>
    </div>
  </body>
</html>`);
});

router.post("/signup", express.urlencoded({ extended: false }), async (req, res, next) => {
  const site = normalizeSite(req.body?.site);
  const ownerEmail = normalizeEmail(req.body?.ownerEmail);
  const plan = normalizePlan(req.body?.plan);
  const country = String(req.body?.country || "CL").trim().toUpperCase();

  if (!site || !ownerEmail) {
    return res.status(400).send(renderSignupResult({
      ok: false,
      hint: "Debes completar sitio y email.",
    }));
  }

  if (!isValidSite(site)) {
    return res.status(400).send(renderSignupResult({
      ok: false,
      hint: "El sitio debe tener formato de dominio valido.",
    }));
  }

  if (!isValidEmail(ownerEmail)) {
    return res.status(400).send(renderSignupResult({
      ok: false,
      hint: "El email no tiene formato valido.",
    }));
  }

  if (!allowOnboardingEmailDomainBypass && !ownerDomainMatchesSite(ownerEmail, site)) {
    return res.status(400).send(renderSignupResult({
      ok: false,
      hint: "El dominio del email debe coincidir con el sitio.",
    }));
  }

  try {
    const existing = await findShopBySite(site);
    if (existing) {
      return res.status(409).send(renderSignupResult({
        ok: false,
        hint: "Ese sitio ya existe. Escribe a soporte para recuperar acceso.",
      }));
    }

    await createShopOnboarding({
      site,
      country,
      plan,
      billingStatus: "active",
    });

    await upsertDashboardAccessPolicy({
      email: ownerEmail,
      role: "customer_owner",
      sites: [site],
      status: "active",
    });

    const ingestKey = generateIngestKey();
    await createApiCredential({
      key: ingestKey,
      site,
      scopes: ["ingest", "read", "export", "shops"],
      status: "active",
    });

    const emailResult = await sendOnboardingWelcomeEmail({
      to: ownerEmail,
      site,
      apiKey: ingestKey,
      plan,
    }).catch(() => ({ sent: false }));

    if (emailResult.sent) {
      return res.status(200).send(renderSignupResult({
        ok: true,
        hint: "Cuenta creada. Enviamos tus credenciales por email.",
      }));
    }

    return res.status(200).send(renderSignupResult({
      ok: true,
      hint: "Cuenta creada. Como fallback te mostramos la API key una sola vez.",
      apiKey: ingestKey,
    }));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
