const express = require("express");
const {
  addEvent,
  listEventsBySite,
  listShops,
  getSiteBilling,
  countEventsBySiteSince,
  findShopBySite,
} = require("../data/store");
const { requireApiKey, requireApiScope, isSiteAuthorized } = require("../middleware/auth");
const { toCsv } = require("../services/csv");
const { createRateLimit } = require("../middleware/rateLimit");
const { getPlanLimitsForBilling } = require("../services/planLimits");
const env = require("../config/env");

const router = express.Router();
const ingestRateLimit = createRateLimit({
  windowMs: 60_000,
  max: 120,
  keyPrefix: "consent:ingest",
});

const ALLOWED_CATEGORIES = new Set(["all", "necessary", "analytics", "marketing"]);
const ALLOWED_ACTIONS = new Set(["accept_all", "reject_non_essential", "custom_preferences"]);
const SITE_PATTERN = /^[a-z0-9.-]{3,255}$/;
const SUBJECT_ID_PATTERN = /^[a-zA-Z0-9:_-]{3,128}$/;

function normalizeSite(site) {
  return String(site || "").trim().toLowerCase();
}

function isValidSite(site) {
  if (!site || !SITE_PATTERN.test(site)) {
    return false;
  }

  return !site.startsWith(".") && !site.endsWith(".") && !site.includes("..");
}

function resolveCountry(rawCountry) {
  const provided = String(rawCountry || "").trim();
  if (!provided) {
    return {
      ok: true,
      value: env.defaultCountryCode,
    };
  }

  const normalized = provided.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return {
      ok: false,
      error: "country must be a 2-letter ISO-like country code",
    };
  }

  return {
    ok: true,
    value: normalized,
  };
}

router.post("/consent-events", requireApiKey, requireApiScope("ingest"), ingestRateLimit, async (req, res, next) => {
  const { category, action, country } = req.body || {};
  const site = normalizeSite(req.body?.site);
  const subjectId = String(req.body?.subjectId || "").trim();
  const countryResolution = resolveCountry(country);

  if (!site || !category || !action) {
    return res.status(400).json({
      error: "site, category and action are required",
    });
  }

  if (!ALLOWED_CATEGORIES.has(category)) {
    return res.status(400).json({
      error: "category must be one of: all, necessary, analytics, marketing",
    });
  }

  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({
      error: "action must be one of: accept_all, reject_non_essential, custom_preferences",
    });
  }

  if (!isValidSite(site)) {
    return res.status(400).json({
      error: "site must be a valid hostname-like identifier",
    });
  }

  if (!countryResolution.ok) {
    return res.status(400).json({ error: countryResolution.error });
  }

  if (subjectId && !SUBJECT_ID_PATTERN.test(subjectId)) {
    return res.status(400).json({ error: "subjectId must be 3-128 chars (letters, numbers, :, _, -)" });
  }

  if (!isSiteAuthorized(req, site)) {
    return res.status(403).json({ error: "Forbidden for this site" });
  }

  try {
    if (env.requireShopOnboarding) {
      const existingShop = await findShopBySite(site);
      if (!existingShop) {
        return res.status(403).json({
          error: "Site is not onboarded",
          hint: "Complete onboarding before sending consent events",
        });
      }
    }

    const billing = await getSiteBilling(site);
    const { effectivePlan, limits } = getPlanLimitsForBilling(billing);
    const startOfWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const eventsLast30Days = await countEventsBySiteSince(site, startOfWindow);

    if (eventsLast30Days >= limits.monthlyEvents) {
      return res.status(402).json({
        error: "Monthly event limit reached for this plan",
        plan: effectivePlan,
        limit: limits.monthlyEvents,
        hint: "Upgrade plan to continue receiving consent events",
      });
    }

    const saved = await addEvent({ site, category, action, country: countryResolution.value, subjectId });
    const event = {
      timestamp: saved.timestamp.toISOString(),
      site: saved.site,
      category: saved.category,
      action: saved.action,
      country: saved.country,
      subjectId: saved.subjectId || null,
    };

    res.status(201).json({ ok: true, event });
  } catch (error) {
    next(error);
  }
});

router.get("/consent-events", requireApiKey, requireApiScope("read"), async (req, res, next) => {
  const site = normalizeSite(req.query.site);
  if (!site) {
    return res.status(400).json({ error: "site query parameter is required" });
  }

  if (!isSiteAuthorized(req, site)) {
    return res.status(403).json({ error: "Forbidden for this site" });
  }

  try {
    const billing = await getSiteBilling(site);
    const { limits } = getPlanLimitsForBilling(billing);
    const events = await listEventsBySite(site, { historyDays: limits.historyDays });
    res.json({ ok: true, count: events.length, events });
  } catch (error) {
    next(error);
  }
});

router.get("/consent-events/export.csv", requireApiKey, requireApiScope("export"), async (req, res, next) => {
  const site = normalizeSite(req.query.site);
  if (!site) {
    return res.status(400).json({ error: "site query parameter is required" });
  }

  if (!isSiteAuthorized(req, site)) {
    return res.status(403).json({ error: "Forbidden for this site" });
  }

  try {
    const billing = await getSiteBilling(site);
    const { effectivePlan, limits } = getPlanLimitsForBilling(billing);

    if (!limits.csvExportAllowed) {
      return res.status(402).json({
        error: "CSV export is not available in free plan",
        plan: effectivePlan,
        hint: "Upgrade to Starter or Pro to enable CSV export",
      });
    }

    const events = await listEventsBySite(site, { historyDays: limits.historyDays });
    const csv = toCsv(events);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=consent-events-${site}.csv`
    );
    res.status(200).send(csv);
  } catch (error) {
    next(error);
  }
});

router.get("/shops", requireApiKey, requireApiScope("shops"), async (req, res, next) => {
  try {
    const shops = await listShops();
    if (req.apiAuth?.site) {
      const scoped = shops.filter((shop) => normalizeSite(shop.site) === req.apiAuth.site);
      return res.json({ ok: true, count: scoped.length, shops: scoped });
    }

    return res.json({ ok: true, count: shops.length, shops });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
