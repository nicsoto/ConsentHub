const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const { resetStoreForTests, upsertSiteBilling } = require("../src/data/store");

const API_KEY = "dev-key-change-me";

function cookieHeaderFrom(setCookie = []) {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function loginAndGetSession(app) {
  const login = await request(app).get("/auth/login");
  const csrfMatch = login.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should exist in login form");

  const csrf = csrfMatch[1];
  const baseCookies = cookieHeaderFrom(login.headers["set-cookie"] || []);

  const reqLink = await request(app)
    .post("/auth/request-link")
    .set("Cookie", baseCookies)
    .type("form")
    .send({ email: "admin@consenthub.local", _csrf: csrf });

  assert.equal(reqLink.status, 200);

  const tokenMatch = reqLink.text.match(/\/auth\/verify\?token=([a-f0-9]+)/);
  assert.ok(tokenMatch, "Magic link token should be present in response");

  const verify = await request(app).get(`/auth/verify?token=${tokenMatch[1]}`);
  assert.equal(verify.status, 302);

  const sessionCookies = cookieHeaderFrom(verify.headers["set-cookie"] || []);

  const merged = [baseCookies, sessionCookies].filter(Boolean).join("; ");
  return { cookie: merged };
}

test("GET /billing/status without session redirects to login", async () => {
  resetStoreForTests();
  const app = createApp();

  const res = await request(app).get("/billing/status").query({ site: "demo.local" });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/auth/login");
});

test("billing mock upgrade updates plan status for a site", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "billing.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);

  const before = await request(app)
    .get("/billing/status")
    .set("Cookie", auth.cookie)
    .query({ site: "billing.local" });

  assert.equal(before.status, 200);
  assert.equal(before.body.plan, "free");

  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should be present in dashboard form");

  const upgraded = await request(app)
    .post("/billing/mock-upgrade")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "billing.local", plan: "starter", _csrf: csrfMatch[1] });

  assert.equal(upgraded.status, 302);
  assert.match(upgraded.headers.location, /Plan\+starter\+activado/);

  const after = await request(app)
    .get("/billing/status")
    .set("Cookie", auth.cookie)
    .query({ site: "billing.local" });

  assert.equal(after.status, 200);
  assert.equal(after.body.plan, "starter");
  assert.equal(after.body.billingStatus, "active");
});

test("billing portal redirects with message when stripe is not configured", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "portal.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);
  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should be present in dashboard form");

  const portal = await request(app)
    .post("/billing/portal")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "portal.local", _csrf: csrfMatch[1] });

  assert.equal(portal.status, 302);
  assert.match(portal.headers.location, /Stripe\+no\+esta\+configurado/);
});

test("billing status reflects past_due with grace period", async () => {
  resetStoreForTests();
  const app = createApp();

  await upsertSiteBilling("downgrade.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_test_downgrade",
    stripeSubscriptionId: "sub_test_downgrade",
  });

  await upsertSiteBilling("downgrade.local", {
    plan: "starter",
    billingStatus: "past_due",
    stripeCustomerId: "cus_test_downgrade",
    stripeSubscriptionId: "sub_test_downgrade",
    gracePeriodEndsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const auth = await loginAndGetSession(app);
  const status = await request(app)
    .get("/billing/status")
    .set("Cookie", auth.cookie)
    .query({ site: "downgrade.local" });

  assert.equal(status.status, 200);
  assert.equal(status.body.plan, "starter");
  assert.equal(status.body.billingStatus, "past_due");
  assert.ok(status.body.gracePeriodEndsAt);
});
