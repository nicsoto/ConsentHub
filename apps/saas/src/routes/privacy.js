const express = require("express");
const {
  listEventsBySiteAndSubject,
  deleteEventsBySiteAndSubject,
  getSiteBilling,
} = require("../data/store");
const { requireApiKey, requireApiScope, isSiteAuthorized } = require("../middleware/auth");
const { getPlanLimitsForBilling } = require("../services/planLimits");

const router = express.Router();

function normalizeSite(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSubject(value) {
  return String(value || "").trim();
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(events) {
  const header = ["timestamp", "site", "subjectId", "category", "action", "country"];
  const rows = events.map((event) => [
    event.timestamp,
    event.site,
    event.subjectId || "",
    event.category,
    event.action,
    event.country,
  ]);
  return [header.join(",")]
    .concat(rows.map((row) => row.map(csvCell).join(",")))
    .join("\n");
}

router.get(
  "/privacy/subjects/:subjectId/data",
  requireApiKey,
  requireApiScope("read"),
  async (req, res, next) => {
    const site = normalizeSite(req.query.site);
    const subjectId = normalizeSubject(req.params.subjectId);

    if (!site || !subjectId) {
      return res.status(400).json({ error: "site and subjectId are required" });
    }

    if (!isSiteAuthorized(req, site)) {
      return res.status(403).json({ error: "Forbidden for this site" });
    }

    try {
      const billing = await getSiteBilling(site);
      const { limits } = getPlanLimitsForBilling(billing);
      const events = await listEventsBySiteAndSubject(site, subjectId, {
        historyDays: limits.historyDays,
      });

      return res.status(200).json({
        ok: true,
        site,
        subjectId,
        count: events.length,
        events,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/privacy/subjects/:subjectId/export.csv",
  requireApiKey,
  requireApiScope("export"),
  async (req, res, next) => {
    const site = normalizeSite(req.query.site);
    const subjectId = normalizeSubject(req.params.subjectId);

    if (!site || !subjectId) {
      return res.status(400).json({ error: "site and subjectId are required" });
    }

    if (!isSiteAuthorized(req, site)) {
      return res.status(403).json({ error: "Forbidden for this site" });
    }

    try {
      const billing = await getSiteBilling(site);
      const { limits } = getPlanLimitsForBilling(billing);
      const events = await listEventsBySiteAndSubject(site, subjectId, {
        historyDays: limits.historyDays,
      });
      const csv = buildCsv(events);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=privacy-${site}-${subjectId}.csv`);
      return res.status(200).send(csv);
    } catch (error) {
      return next(error);
    }
  }
);

router.delete(
  "/privacy/subjects/:subjectId",
  requireApiKey,
  requireApiScope("export"),
  async (req, res, next) => {
    const site = normalizeSite(req.query.site);
    const subjectId = normalizeSubject(req.params.subjectId);

    if (!site || !subjectId) {
      return res.status(400).json({ error: "site and subjectId are required" });
    }

    if (!isSiteAuthorized(req, site)) {
      return res.status(403).json({ error: "Forbidden for this site" });
    }

    try {
      const result = await deleteEventsBySiteAndSubject(site, subjectId);
      return res.status(200).json({
        ok: true,
        site,
        subjectId,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
