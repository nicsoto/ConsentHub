const express = require("express");
const env = require("../config/env");
const { renderPrometheus } = require("../lib/metrics");

const router = express.Router();

function isAuthorized(req) {
  const expected = env.metricsBearerToken;
  if (!expected) {
    return true;
  }

  const authHeader = String(req.headers.authorization || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return false;
  }

  const token = authHeader.slice(7).trim();
  return token === expected;
}

function normalizeIp(value) {
  const ip = String(value || "").trim().toLowerCase();
  if (!ip) {
    return "";
  }
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }
  return ip;
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1";
}

function isAllowedByIp(req) {
  const allowlist = Array.isArray(env.metricsAllowedIps) ? env.metricsAllowedIps : [];
  if (allowlist.length === 0) {
    return true;
  }

  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => normalizeIp(value))
    .filter(Boolean);

  const candidates = new Set(
    [
      normalizeIp(req.ip),
      normalizeIp(req.connection?.remoteAddress),
      normalizeIp(req.socket?.remoteAddress),
      ...forwarded,
    ].filter(Boolean)
  );

  const allowed = allowlist.map((value) => normalizeIp(value)).filter(Boolean);

  for (const candidate of candidates) {
    for (const allow of allowed) {
      if (candidate === allow) {
        return true;
      }
      if (isLoopback(candidate) && isLoopback(allow)) {
        return true;
      }
    }
  }

  return false;
}

router.get("/metrics", (req, res) => {
  if (!env.metricsEnabled) {
    return res.status(404).send("Not found");
  }

  if (!isAllowedByIp(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return res.status(200).send(renderPrometheus());
});

module.exports = router;
