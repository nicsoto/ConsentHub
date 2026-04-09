const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const { prisma } = require("../src/lib/prisma");
const env = require("../src/config/env");
const stripeService = require("../src/services/stripeClient");

test("GET /livez returns liveness payload", async () => {
  const app = createApp();
  const res = await request(app).get("/livez");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, "consenthub-saas");
  assert.ok(["web", "worker", "all"].includes(res.body.role));
  assert.equal(typeof res.body.jobsInThisProcess, "boolean");
  assert.equal(typeof res.body.webInThisProcess, "boolean");
  assert.equal(typeof res.headers["x-request-id"], "string");
  assert.ok(res.headers["x-request-id"].length > 0);
});

test("GET /readyz returns readiness payload with checks", async () => {
  const app = createApp();
  const res = await request(app).get("/readyz");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, "consenthub-saas");
  assert.ok(["web", "worker", "all"].includes(res.body.role));
  assert.equal(typeof res.body.jobsInThisProcess, "boolean");
  assert.equal(typeof res.body.webInThisProcess, "boolean");
  assert.equal(typeof res.body.checks, "object");
  assert.equal(typeof res.body.checks.db, "object");
  assert.equal(typeof res.body.checks.stripe, "object");
  assert.ok(["ok", "skipped"].includes(res.body.checks.db.status));
  assert.equal(typeof res.body.checks.db.durationMs, "number");
  assert.equal(res.body.checks.stripe.status, "skipped");
  assert.equal(res.body.checks.stripe.reason, "disabled");
  assert.equal(typeof res.body.checks.stripe.durationMs, "number");
  if (res.body.checks.db.status === "skipped") {
    assert.equal(res.body.checks.db.reason, "in-memory-store");
  }
});

test("GET /health keeps backward-compatible readiness payload", async () => {
  const app = createApp();
  const res = await request(app).get("/health");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.checks, "object");
  assert.equal(typeof res.body.checks.db, "object");
  assert.equal(typeof res.body.checks.stripe, "object");
  assert.equal(typeof res.headers["x-request-id"], "string");
  assert.ok(res.headers["x-request-id"].length > 0);
});

test("GET /readyz propagates x-request-id header when provided", async () => {
  const app = createApp();
  const reqId = "req-health-123";
  const res = await request(app).get("/readyz").set("x-request-id", reqId);

  assert.equal(res.status, 200);
  assert.equal(res.headers["x-request-id"], reqId);
});

test("GET /readyz returns 503 when DB readiness probe times out", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUseInMemoryStore = process.env.USE_IN_MEMORY_STORE;
  const originalQueryRaw = prisma.$queryRaw;

  process.env.NODE_ENV = "development";
  process.env.USE_IN_MEMORY_STORE = "false";
  prisma.$queryRaw = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return [{ ok: 1 }];
  };

  try {
    const app = createApp();
    const res = await request(app).get("/readyz");

    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.checks.db.status, "error");
    assert.equal(res.body.checks.db.reason, "timeout");
    assert.equal(typeof res.body.checks.db.durationMs, "number");
  } finally {
    prisma.$queryRaw = originalQueryRaw;
    if (typeof originalNodeEnv === "undefined") {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (typeof originalUseInMemoryStore === "undefined") {
      delete process.env.USE_IN_MEMORY_STORE;
    } else {
      process.env.USE_IN_MEMORY_STORE = originalUseInMemoryStore;
    }
  }
});

test("GET /readyz returns 503 when Stripe readiness is enabled but config is missing", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUseInMemoryStore = process.env.USE_IN_MEMORY_STORE;
  const originalReadinessCheckStripe = env.readinessCheckStripe;
  const originalHasStripeBillingConfig = stripeService.hasStripeBillingConfig;

  process.env.NODE_ENV = "development";
  process.env.USE_IN_MEMORY_STORE = "false";
  env.readinessCheckStripe = true;
  stripeService.hasStripeBillingConfig = () => false;

  try {
    const app = createApp();
    const res = await request(app).get("/readyz");

    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.checks.stripe.status, "error");
    assert.equal(res.body.checks.stripe.reason, "missing-config");
    assert.equal(typeof res.body.checks.stripe.durationMs, "number");
  } finally {
    stripeService.hasStripeBillingConfig = originalHasStripeBillingConfig;
    env.readinessCheckStripe = originalReadinessCheckStripe;
    if (typeof originalNodeEnv === "undefined") {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (typeof originalUseInMemoryStore === "undefined") {
      delete process.env.USE_IN_MEMORY_STORE;
    } else {
      process.env.USE_IN_MEMORY_STORE = originalUseInMemoryStore;
    }
  }
});

test("GET /readyz returns 503 when Stripe readiness probe times out", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUseInMemoryStore = process.env.USE_IN_MEMORY_STORE;
  const originalReadinessCheckStripe = env.readinessCheckStripe;
  const originalReadinessStripeTimeoutMs = env.readinessStripeTimeoutMs;
  const originalHasStripeBillingConfig = stripeService.hasStripeBillingConfig;
  const originalGetStripeClient = stripeService.getStripeClient;

  process.env.NODE_ENV = "development";
  process.env.USE_IN_MEMORY_STORE = "false";
  env.readinessCheckStripe = true;
  env.readinessStripeTimeoutMs = 100;
  stripeService.hasStripeBillingConfig = () => true;
  stripeService.getStripeClient = () => ({
    balance: {
      retrieve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { object: "balance" };
      },
    },
  });

  try {
    const app = createApp();
    const res = await request(app).get("/readyz");

    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.checks.stripe.status, "error");
    assert.equal(res.body.checks.stripe.reason, "timeout");
    assert.equal(typeof res.body.checks.stripe.durationMs, "number");
  } finally {
    stripeService.getStripeClient = originalGetStripeClient;
    stripeService.hasStripeBillingConfig = originalHasStripeBillingConfig;
    env.readinessStripeTimeoutMs = originalReadinessStripeTimeoutMs;
    env.readinessCheckStripe = originalReadinessCheckStripe;
    if (typeof originalNodeEnv === "undefined") {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (typeof originalUseInMemoryStore === "undefined") {
      delete process.env.USE_IN_MEMORY_STORE;
    } else {
      process.env.USE_IN_MEMORY_STORE = originalUseInMemoryStore;
    }
  }
});
