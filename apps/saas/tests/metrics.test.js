const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createApp } = require("../src/app");
const env = require("../src/config/env");
const { createRateLimit } = require("../src/middleware/rateLimit");
const { renderPrometheus, resetMetricsForTests } = require("../src/lib/metrics");
const { resetStoreForTests } = require("../src/data/store");

test("GET /metrics exposes prometheus counters and request labels", async () => {
  resetStoreForTests();
  resetMetricsForTests();

  const app = createApp();
  const livez = await request(app).get("/livez");
  assert.equal(livez.status, 200);

  const metrics = await request(app).get("/metrics");
  assert.equal(metrics.status, 200);
  assert.match(String(metrics.headers["content-type"] || ""), /text\/plain/);
  assert.match(metrics.text, /# TYPE consenthub_http_requests_total counter/);
  assert.match(metrics.text, /# TYPE consenthub_http_request_duration_ms histogram/);
  assert.match(metrics.text, /consenthub_http_request_duration_ms_bucket\{[^\n]*le="\+Inf"[^\n]*\}/);
  assert.match(metrics.text, /route="\/livez"/);
});

test("GET /metrics returns 404 when metrics are disabled", async () => {
  resetStoreForTests();
  resetMetricsForTests();

  const originalEnabled = env.metricsEnabled;
  env.metricsEnabled = false;

  try {
    const app = createApp();
    const res = await request(app).get("/metrics");
    assert.equal(res.status, 404);
  } finally {
    env.metricsEnabled = originalEnabled;
  }
});

test("GET /metrics requires bearer token when configured", async () => {
  resetStoreForTests();
  resetMetricsForTests();

  const originalToken = env.metricsBearerToken;
  env.metricsBearerToken = "token-abc";

  try {
    const app = createApp();

    const unauthorized = await request(app).get("/metrics");
    assert.equal(unauthorized.status, 401);

    const authorized = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer token-abc");

    assert.equal(authorized.status, 200);
    assert.match(authorized.text, /consenthub_http_requests_total/);
  } finally {
    env.metricsBearerToken = originalToken;
  }
});

test("GET /metrics blocks requests not in allowlisted IPs", async () => {
  resetStoreForTests();
  resetMetricsForTests();

  const originalAllowlist = env.metricsAllowedIps;
  env.metricsAllowedIps = ["203.0.113.10"];

  try {
    const app = createApp();
    const res = await request(app).get("/metrics");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "Forbidden");
  } finally {
    env.metricsAllowedIps = originalAllowlist;
  }
});

test("GET /metrics allows loopback when loopback is allowlisted", async () => {
  resetStoreForTests();
  resetMetricsForTests();

  const originalAllowlist = env.metricsAllowedIps;
  env.metricsAllowedIps = ["127.0.0.1"];

  try {
    const app = createApp();
    const res = await request(app).get("/metrics");
    assert.equal(res.status, 200);
  } finally {
    env.metricsAllowedIps = originalAllowlist;
  }
});

test("rate limiter increments rate limit rejection metric", async () => {
  resetStoreForTests();
  resetMetricsForTests();

  const app = express();
  app.use(createRateLimit({ windowMs: 60_000, max: 1, keyPrefix: "test:metrics-limit" }));
  app.get("/limited", (_req, res) => res.status(200).json({ ok: true }));

  const first = await request(app).get("/limited");
  const second = await request(app).get("/limited");

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);

  const exposition = renderPrometheus();
  assert.match(exposition, /consenthub_rate_limit_rejections_total\{keyPrefix="test:metrics-limit",route="\/limited"\} 1/);
});
