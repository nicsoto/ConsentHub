const express = require("express");
const env = require("../config/env");
const { prisma } = require("../lib/prisma");
const stripeService = require("../services/stripeClient");
const logger = require("../lib/logger");

const router = express.Router();

function nowMs() {
  return Date.now();
}

function durationMs(startedAt) {
  return Math.max(0, nowMs() - startedAt);
}

function logReadiness(requestId, result) {
  const entry = {
    event: "readiness_check",
    requestId,
    ok: result.ok,
    role: env.appRole,
    checks: result.checks,
  };

  if (result.ok) {
    logger.info(entry);
    return;
  }

  logger.error(entry);
}

function buildBasePayload() {
  return {
    service: "consenthub-saas",
    version: "0.1.0",
    role: env.appRole,
    jobsInThisProcess: env.appRole === "worker" || env.appRole === "all",
    webInThisProcess: env.appRole === "web" || env.appRole === "all",
  };
}

async function withTimeout(promise, timeoutMs, timeoutCode) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(timeoutCode || "readiness-timeout");
          error.code = timeoutCode || "READINESS_TIMEOUT";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function runReadinessChecks() {
  const isInMemoryMode = process.env.NODE_ENV === "test" || process.env.USE_IN_MEMORY_STORE === "true";
  const checks = {
    db: { status: "ok" },
    stripe: { status: "skipped", reason: "disabled" },
  };
  let ok = true;
  const dbStartedAt = nowMs();

  if (isInMemoryMode) {
    checks.db = {
      status: "skipped",
      reason: "in-memory-store",
      durationMs: durationMs(dbStartedAt),
    };
  } else {
    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, env.readinessDbTimeoutMs, "READINESS_DB_TIMEOUT");
      checks.db = {
        status: "ok",
        durationMs: durationMs(dbStartedAt),
      };
    } catch (error) {
      checks.db = {
        status: "error",
        reason: error && error.code === "READINESS_DB_TIMEOUT" ? "timeout" : "query-failed",
        durationMs: durationMs(dbStartedAt),
      };
      ok = false;
    }
  }

  const stripeStartedAt = nowMs();

  if (env.readinessCheckStripe) {
    if (!stripeService.hasStripeBillingConfig()) {
      checks.stripe = {
        status: "error",
        reason: "missing-config",
        durationMs: durationMs(stripeStartedAt),
      };
      ok = false;
    } else {
      const stripeClient = stripeService.getStripeClient();
      if (!stripeClient || !stripeClient.balance || typeof stripeClient.balance.retrieve !== "function") {
        checks.stripe = {
          status: "error",
          reason: "client-unavailable",
          durationMs: durationMs(stripeStartedAt),
        };
        ok = false;
      } else {
        try {
          await withTimeout(
            stripeClient.balance.retrieve(),
            env.readinessStripeTimeoutMs,
            "READINESS_STRIPE_TIMEOUT"
          );
          checks.stripe = {
            status: "ok",
            durationMs: durationMs(stripeStartedAt),
          };
        } catch (error) {
          checks.stripe = {
            status: "error",
            reason: error && error.code === "READINESS_STRIPE_TIMEOUT" ? "timeout" : "probe-failed",
            durationMs: durationMs(stripeStartedAt),
          };
          ok = false;
        }
      }
    }
  } else {
    checks.stripe.durationMs = durationMs(stripeStartedAt);
  }

  return { ok, checks };
}

router.get("/livez", (_req, res) => {
  res.json({
    ok: true,
    ...buildBasePayload(),
  });
});

async function readinessHandler(_req, res) {
  const requestId = String(_req.requestId || "").trim() || "unknown-request";

  const readiness = await runReadinessChecks();
  logReadiness(requestId, readiness);
  const payload = {
    ok: readiness.ok,
    ...buildBasePayload(),
    checks: readiness.checks,
  };

  if (!readiness.ok) {
    return res.status(503).json(payload);
  }

  return res.json(payload);
}

router.get("/readyz", readinessHandler);
router.get("/health", readinessHandler);

module.exports = router;
