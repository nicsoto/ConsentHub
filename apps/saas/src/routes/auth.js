const express = require("express");
const crypto = require("crypto");
const envConfig = require("../config/env");
const { issueMagicToken, consumeMagicToken } = require("../services/magicLinkStore");
const {
  createSessionValue,
  attachSessionCookie,
  clearSessionCookie,
  parseCookies,
} = require("../services/session");
const { sessionSecret } = require("../config/env");
const { sendMagicLinkEmail } = require("../services/email");
const { findDashboardAccessPolicyByEmail } = require("../data/store");
const { createRateLimit } = require("../middleware/rateLimit");
const { ensureCsrfCookie, requireCsrf } = require("../middleware/csrf");

const router = express.Router();
const magicLinkRateLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyPrefix: "auth:magic-link",
});
const OIDC_STATE_COOKIE = "consenthub_oidc_state";
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
let oidcDiscoveryCache = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLogin(csrfToken, message = "", loginLink = "") {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Login Dashboard</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      form, .box { background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 20px; width: min(480px, 92vw); }
      label { display: block; margin-bottom: 8px; }
      input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #334155; background: #0b1220; color: #e2e8f0; }
      button { margin-top: 12px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #2563eb; color: white; font-weight: 700; cursor: pointer; }
      h1 { margin: 0 0 12px; font-size: 20px; }
      p { color: #94a3b8; margin: 0 0 14px; }
      .ok { color: #86efac; margin-top: 8px; }
      a { color: #93c5fd; }
    </style>
  </head>
  <body>
    <form method="post" action="/auth/request-link">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
      <h1>Acceso Dashboard</h1>
      <p>Ingresa tu email de admin y te enviamos un magic link.</p>
      ${envConfig.dashboardSsoEnabled ? '<p><a href="/auth/sso">Entrar con SSO (Bridge)</a></p>' : ""}
      ${envConfig.dashboardOidcEnabled ? '<p><a href="/auth/oidc/start">Entrar con SSO corporativo (OIDC)</a></p>' : ""}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required />
      <button type="submit">Enviar link</button>
      ${message ? `<p class="ok">${escapeHtml(message)}</p>` : ""}
      ${loginLink ? `<p class="ok">Modo desarrollo: <a href="${escapeHtml(loginLink)}">Abrir magic link</a></p>` : ""}
    </form>
  </body>
</html>`;
}

function safeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch (_error) {
    return false;
  }
}

function normalizeRole(roleInput) {
  const role = String(roleInput || "").trim().toLowerCase();
  const allowed = new Set(["admin", "operator", "billing_manager", "analyst", "customer_owner", "customer_viewer"]);
  return allowed.has(role) ? role : "";
}

function normalizeSites(sitesInput) {
  const raw = Array.isArray(sitesInput)
    ? sitesInput
    : String(sitesInput || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

  const normalized = [...new Set(raw.map((site) => String(site || "").trim().toLowerCase()).filter(Boolean))];
  if (normalized.includes("*")) {
    return ["*"];
  }
  return normalized;
}

function postLoginRedirectPath(roleInput) {
  const role = String(roleInput || "").trim().toLowerCase();
  if (role === "customer_owner" || role === "customer_viewer") {
    return "/customer-portal";
  }
  return "/dashboard-v2";
}

function parseSsoJwt(token, secret) {
  const raw = String(token || "").trim();
  if (!raw || !secret) {
    return null;
  }

  const parts = raw.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }

  if (String(header?.alg || "").toUpperCase() !== "HS256") {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  if (!safeEqual(expected, signatureB64)) {
    return null;
  }

  const exp = Number(payload?.exp || 0);
  if (Number.isFinite(exp) && exp > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds > exp) {
      return null;
    }
  }

  return payload;
}

function signValue(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function verifyHexSignature(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch (_error) {
    return false;
  }
}

function createOidcStateCookieValue(secret) {
  const state = crypto.randomBytes(18).toString("base64url");
  const nonce = crypto.randomBytes(18).toString("base64url");
  const exp = Date.now() + OIDC_STATE_TTL_MS;
  const encoded = Buffer.from(JSON.stringify({ state, nonce, exp }), "utf8").toString("base64url");
  const signature = signValue(encoded, secret);
  return {
    state,
    nonce,
    value: `${encoded}.${signature}`,
  };
}

function parseOidcStateCookieValue(raw, secret) {
  const value = String(raw || "");
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) {
    return null;
  }

  const expected = signValue(encoded, secret);
  if (!verifyHexSignature(signature, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const state = String(parsed.state || "");
    const nonce = String(parsed.nonce || "");
    const exp = Number(parsed.exp || 0);
    if (!state || !nonce || !Number.isFinite(exp) || Date.now() > exp) {
      return null;
    }
    return { state, nonce };
  } catch (_error) {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }
  return response.json();
}

async function getOidcDiscovery() {
  if (oidcDiscoveryCache && Date.now() < oidcDiscoveryCache.expiresAt) {
    return oidcDiscoveryCache.value;
  }

  const baseIssuer = String(envConfig.dashboardOidcIssuer || "").trim().replace(/\/$/, "");
  if (!baseIssuer) {
    throw new Error("oidc_missing_issuer");
  }

  const discoveryUrl = String(envConfig.dashboardOidcDiscoveryUrl || `${baseIssuer}/.well-known/openid-configuration`);
  const data = await fetchJson(discoveryUrl);
  if (!data.authorization_endpoint || !data.token_endpoint || !data.jwks_uri) {
    throw new Error("oidc_discovery_incomplete");
  }

  oidcDiscoveryCache = {
    value: data,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };

  return data;
}

function decodeJwtParts(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64, "base64url");

    return { header, payload, signingInput, signature };
  } catch (_error) {
    return null;
  }
}

function verifyIdTokenClaims(payload, nonce) {
  const issuer = String(envConfig.dashboardOidcIssuer || "").trim().replace(/\/$/, "");
  const clientId = String(envConfig.dashboardOidcClientId || "").trim();
  const now = Math.floor(Date.now() / 1000);

  if (!issuer || !clientId) {
    return false;
  }

  if (String(payload.iss || "").trim().replace(/\/$/, "") !== issuer) {
    return false;
  }

  const aud = Array.isArray(payload.aud) ? payload.aud.map((item) => String(item || "")) : [String(payload.aud || "")];
  if (!aud.includes(clientId)) {
    return false;
  }

  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(exp) || now > exp) {
    return false;
  }

  const nbf = Number(payload.nbf || 0);
  if (Number.isFinite(nbf) && nbf > 0 && now + 60 < nbf) {
    return false;
  }

  if (nonce && String(payload.nonce || "") !== String(nonce)) {
    return false;
  }

  return true;
}

async function verifyOidcIdToken(idToken, nonce, jwksUri) {
  const decoded = decodeJwtParts(idToken);
  if (!decoded) {
    return null;
  }

  const { header, payload, signingInput, signature } = decoded;
  if (String(header.alg || "") !== "RS256") {
    return null;
  }

  const jwks = await fetchJson(jwksUri);
  const kid = String(header.kid || "");
  const key = Array.isArray(jwks?.keys)
    ? jwks.keys.find((candidate) => String(candidate.kid || "") === kid)
    : null;

  if (!key) {
    return null;
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key, format: "jwk" });
  } catch (_error) {
    return null;
  }

  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    publicKey,
    signature
  );

  if (!ok || !verifyIdTokenClaims(payload, nonce)) {
    return null;
  }

  return payload;
}

function oidcRedirectUri() {
  const configured = String(envConfig.dashboardOidcRedirectUri || "").trim();
  return configured || `${envConfig.appBaseUrl}/auth/oidc/callback`;
}

function clearOidcStateCookie(res) {
  res.cookie(OIDC_STATE_COOKIE, "", {
    httpOnly: true,
    secure: envConfig.isSecureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function extractOidcEmail(claims) {
  return String(
    claims?.email ||
    claims?.preferred_username ||
    claims?.upn ||
    ""
  ).trim().toLowerCase();
}

async function resolveAccess(emailInput) {
  const email = String(emailInput || "").trim().toLowerCase();
  if (!email) {
    return null;
  }

  try {
    const policy = await findDashboardAccessPolicyByEmail(email);
    if (policy && String(policy.status || "active").toLowerCase() === "active") {
      return {
        email,
        role: String(policy.role || "admin").toLowerCase(),
        sites: Array.isArray(policy.sites) && policy.sites.length > 0 ? policy.sites : ["*"],
      };
    }
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const code = String(error?.code || "").toLowerCase();
    const relationMissing = message.includes("dashboardaccesspolicy") || message.includes("does not exist");
    const prismaMissingTable = code === "p2021";
    if (!(relationMissing || prismaMissingTable)) {
      throw error;
    }
  }

  return envConfig.resolveDashboardAccess(email);
}

router.get("/auth/login", ensureCsrfCookie, (_req, res) => {
  res.status(200).send(renderLogin(_req.csrfToken));
});

router.post(
  "/auth/request-link",
  ensureCsrfCookie,
  requireCsrf,
  magicLinkRateLimit,
  async (req, res) => {
  const emailRaw = req.body?.email || "";
  const email = String(emailRaw).trim().toLowerCase();

  if (!email) {
    return res.status(400).send(renderLogin(req.csrfToken, "Email invalido"));
  }

  const access = await resolveAccess(email);
  if (!access) {
    // Response intentionally ambiguous.
    return res
      .status(200)
      .send(renderLogin(req.csrfToken, "Si el email existe, se envio un enlace."));
  }

  const { token } = await issueMagicToken(email);
  const link = `${envConfig.appBaseUrl}/auth/verify?token=${token}`;

  let sendResult;
  try {
    sendResult = await sendMagicLinkEmail(email, link);
  } catch (error) {
    console.error("[auth] failed to send magic link", error.message);
    return res
      .status(500)
      .send(renderLogin(req.csrfToken, "No se pudo enviar el enlace. Intenta de nuevo."));
  }

  console.log(`[auth] magic link para ${email}: ${link}`);

  const isProd = process.env.NODE_ENV === "production";

  if (isProd && !sendResult.sent) {
    return res.status(500).send(renderLogin(req.csrfToken, "Configuracion de email incompleta en servidor."));
  }

  const devLink = isProd ? "" : link;
  const message = sendResult.sent
    ? "Te enviamos un enlace de acceso a tu email."
    : "Configuracion de email pendiente. Usa temporalmente el enlace de desarrollo.";

  return res.status(200).send(renderLogin(req.csrfToken, message, devLink));
  }
);

router.get("/auth/verify", async (req, res) => {
  const token = req.query.token;
  const email = await consumeMagicToken(String(token || ""));

  if (!email) {
    return res.status(401).send("Enlace invalido o expirado.");
  }

  const access = await resolveAccess(email);
  if (!access) {
    return res.status(403).send("Cuenta sin acceso al dashboard.");
  }

  const value = createSessionValue(email, sessionSecret, {
    role: access.role,
    sites: access.sites,
  });
  attachSessionCookie(res, value, envConfig.isSecureCookies);
  return res.redirect(postLoginRedirectPath(access.role));
});

router.get("/auth/sso", async (req, res) => {
  if (!envConfig.dashboardSsoEnabled) {
    return res.status(404).send("SSO no habilitado");
  }

  if (!envConfig.dashboardSsoHeaderSecret && !envConfig.dashboardSsoJwtSecret) {
    return res.status(503).send("Bridge SSO mal configurado");
  }

  if (envConfig.dashboardSsoHeaderSecret) {
    const inboundSecret = String(req.get("x-sso-secret") || "").trim();
    if (!inboundSecret || !safeEqual(inboundSecret, envConfig.dashboardSsoHeaderSecret)) {
      return res.status(401).send("SSO secret invalido");
    }
  }

  const jwtToken = String(req.get(envConfig.dashboardSsoHeaderJwt) || "").trim();
  const jwtSecret = envConfig.dashboardSsoJwtSecret || envConfig.dashboardSsoHeaderSecret;
  const jwtClaims = jwtToken ? parseSsoJwt(jwtToken, jwtSecret) : null;
  if (jwtToken && !jwtClaims) {
    return res.status(401).send("JWT SSO invalido");
  }

  const email = String(jwtClaims?.email || req.get(envConfig.dashboardSsoHeaderEmail) || "").trim().toLowerCase();
  const access = await resolveAccess(email);
  if (!access) {
    return res.status(403).send("Usuario SSO sin acceso");
  }

  const requestedSites = jwtClaims
    ? normalizeSites(jwtClaims.sites)
    : String(req.get(envConfig.dashboardSsoHeaderSites) || "")
        .split(",")
        .map((site) => site.trim().toLowerCase())
        .filter(Boolean);

  const sites = requestedSites.length > 0 && !access.sites.includes("*")
    ? requestedSites.filter((site) => access.sites.includes(site))
    : (requestedSites.length > 0 && access.sites.includes("*") ? requestedSites : access.sites);

  const sessionSites = sites.length > 0 ? sites : access.sites;

  const requestedRole = normalizeRole(jwtClaims?.role);
  const sessionRole = requestedRole && String(access.role || "") === "admin"
    ? requestedRole
    : access.role;

  const value = createSessionValue(email, sessionSecret, {
    role: sessionRole,
    sites: sessionSites,
  });
  attachSessionCookie(res, value, envConfig.isSecureCookies);
  return res.redirect(postLoginRedirectPath(sessionRole));
});

router.get("/auth/oidc/start", async (_req, res) => {
  if (!envConfig.dashboardOidcEnabled) {
    return res.status(404).send("OIDC no habilitado");
  }

  try {
    const discovery = await getOidcDiscovery();
    const { state, nonce, value } = createOidcStateCookieValue(sessionSecret);
    const scopes = String(envConfig.dashboardOidcScopes || "openid email profile").trim();

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", envConfig.dashboardOidcClientId);
    authUrl.searchParams.set("redirect_uri", oidcRedirectUri());
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("nonce", nonce);

    res.cookie(OIDC_STATE_COOKIE, value, {
      httpOnly: true,
      secure: envConfig.isSecureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: OIDC_STATE_TTL_MS,
    });

    return res.redirect(authUrl.toString());
  } catch (error) {
    console.error("[auth] oidc start failed", error.message);
    return res.status(500).send("No se pudo iniciar flujo OIDC");
  }
});

router.get("/auth/oidc/callback", async (req, res) => {
  if (!envConfig.dashboardOidcEnabled) {
    return res.status(404).send("OIDC no habilitado");
  }

  if (req.query.error) {
    clearOidcStateCookie(res);
    return res.status(401).send(`OIDC rechazo autenticacion: ${String(req.query.error)}`);
  }

  const code = String(req.query.code || "").trim();
  const state = String(req.query.state || "").trim();
  const cookies = parseCookies(req.headers.cookie || "");
  const stateCookie = parseOidcStateCookieValue(cookies[OIDC_STATE_COOKIE], sessionSecret);

  if (!code || !state || !stateCookie || stateCookie.state !== state) {
    clearOidcStateCookie(res);
    return res.status(401).send("OIDC state invalido");
  }

  try {
    const discovery = await getOidcDiscovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oidcRedirectUri(),
      client_id: envConfig.dashboardOidcClientId,
      client_secret: envConfig.dashboardOidcClientSecret,
    });

    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      clearOidcStateCookie(res);
      return res.status(401).send("OIDC token exchange fallido");
    }

    const tokenPayload = await tokenResponse.json();
    const idToken = String(tokenPayload.id_token || "").trim();
    const claims = await verifyOidcIdToken(idToken, stateCookie.nonce, discovery.jwks_uri);
    if (!claims) {
      clearOidcStateCookie(res);
      return res.status(401).send("OIDC id_token invalido");
    }

    const email = extractOidcEmail(claims);
    const access = await resolveAccess(email);
    if (!access) {
      clearOidcStateCookie(res);
      return res.status(403).send("Usuario OIDC sin acceso");
    }

    const value = createSessionValue(email, sessionSecret, {
      role: access.role,
      sites: access.sites,
    });

    clearOidcStateCookie(res);
    attachSessionCookie(res, value, envConfig.isSecureCookies);
    return res.redirect(postLoginRedirectPath(access.role));
  } catch (error) {
    console.error("[auth] oidc callback failed", error.message);
    clearOidcStateCookie(res);
    return res.status(401).send("OIDC callback invalido");
  }
});

router.post("/auth/logout", ensureCsrfCookie, requireCsrf, (_req, res) => {
  clearSessionCookie(res, envConfig.isSecureCookies);
  return res.redirect("/auth/login");
});

module.exports = router;
