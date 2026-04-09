const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const { resetStoreForTests, upsertSiteBilling } = require("../src/data/store");

const API_KEY = "dev-key-change-me";

test("past_due with active grace still allows starter CSV export", async () => {
  resetStoreForTests();
  const app = createApp();

  await upsertSiteBilling("grace-ok.local", {
    plan: "starter",
    billingStatus: "past_due",
    gracePeriodEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site: "grace-ok.local",
      category: "all",
      action: "accept_all",
      country: "CL",
    });

  const exported = await request(app)
    .get("/consent-events/export.csv")
    .set("x-api-key", API_KEY)
    .query({ site: "grace-ok.local" });

  assert.equal(exported.status, 200);
});

test("past_due after grace expiry behaves as free plan", async () => {
  resetStoreForTests();
  const app = createApp();

  await upsertSiteBilling("grace-expired.local", {
    plan: "starter",
    billingStatus: "past_due",
    gracePeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });

  const exported = await request(app)
    .get("/consent-events/export.csv")
    .set("x-api-key", API_KEY)
    .query({ site: "grace-expired.local" });

  assert.equal(exported.status, 402);
  assert.match(exported.body.error, /CSV export is not available/i);
});
