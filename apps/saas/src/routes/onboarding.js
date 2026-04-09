const express = require("express");
const crypto = require("crypto");
const env = require("../config/env");
const {
  findShopBySite,
  createShopOnboarding,
  createApiCredential,
  upsertDashboardAccessPolicy,
  countEventsBySiteSince,
} = require("../data/store");

const router = express.Router();
const SITE_PATTERN = /^[a-z0-9.-]{3,255}$/;

function normalizeSite(site) {
  return String(site || "").trim().toLowerCase();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePlan(plan) {
  const raw = String(plan || "free").trim().toLowerCase();
  if (raw === "starter" || raw === "pro") {
    return raw;
  }
  return "free";
}

function isValidSite(site) {
  if (!site || !SITE_PATTERN.test(site)) {
    return false;
  }
  return !site.startsWith(".") && !site.endsWith(".") && !site.includes("..");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function ownerDomainMatchesSite(ownerEmail, site) {
  const domain = String(ownerEmail || "").split("@")[1] || "";
  if (!domain) {
    return false;
  }
  return site === domain || site.endsWith(`.${domain}`);
}

function ensureOnboardingAuth(req, res) {
  const secret = String(env.onboardingSecret || "").trim();
  if (!secret) {
    return true;
  }

  const provided = String(req.get("x-onboarding-secret") || "").trim();
  if (!provided || provided !== secret) {
    res.status(401).json({ error: "Invalid onboarding secret" });
    return false;
  }

  return true;
}

function generateIngestKey() {
  return `ch_ing_${crypto.randomBytes(20).toString("hex")}`;
}

router.post("/onboarding/register", async (req, res, next) => {
  if (!ensureOnboardingAuth(req, res)) {
    return;
  }

  const site = normalizeSite(req.body?.site);
  const ownerEmail = normalizeEmail(req.body?.ownerEmail);
  const plan = normalizePlan(req.body?.plan);
  const country = String(req.body?.country || "CL").trim().toUpperCase();

  if (!site || !ownerEmail) {
    return res.status(400).json({ error: "site and ownerEmail are required" });
  }

  if (!isValidSite(site)) {
    return res.status(400).json({ error: "site must be a valid hostname-like identifier" });
  }

  if (!isValidEmail(ownerEmail)) {
    return res.status(400).json({ error: "ownerEmail is invalid" });
  }

  if (!env.allowOnboardingEmailDomainBypass && !ownerDomainMatchesSite(ownerEmail, site)) {
    return res.status(400).json({
      error: "ownerEmail domain does not match site domain",
      hint: "Use an owner email from the same domain or enable ALLOW_ONBOARDING_EMAIL_DOMAIN_BYPASS",
    });
  }

  try {
    const existing = await findShopBySite(site);
    if (existing) {
      return res.status(409).json({ error: "site already onboarded" });
    }

    await createShopOnboarding({
      site,
      country,
      plan,
      billingStatus: plan === "free" ? "inactive" : "active",
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

    return res.status(201).json({
      ok: true,
      site,
      ownerEmail,
      plan,
      credential: {
        key: ingestKey,
        scopes: ["ingest", "read", "export", "shops"],
      },
      checklist: [
        "Configura la API key en tu plugin",
        "Envia un evento de prueba a /consent-events",
        "Ingresa por magic link con ownerEmail para abrir /customer-portal",
      ],
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/onboarding/status", async (req, res, next) => {
  if (!ensureOnboardingAuth(req, res)) {
    return;
  }

  const site = normalizeSite(req.query.site);
  if (!site) {
    return res.status(400).json({ error: "site query parameter is required" });
  }

  try {
    const shop = await findShopBySite(site);
    if (!shop) {
      return res.status(404).json({ error: "site not found" });
    }

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const eventsLast24h = await countEventsBySiteSince(site, from);

    return res.status(200).json({
      ok: true,
      site,
      onboarded: true,
      pluginHealthy: eventsLast24h > 0,
      eventsLast24h,
      billingStatus: shop.billingStatus,
      plan: shop.plan,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
