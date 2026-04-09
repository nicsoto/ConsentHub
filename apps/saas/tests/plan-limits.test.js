const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const { resetStoreForTests, upsertSiteBilling, addEvent } = require("../src/data/store");

const API_KEY = "dev-key-change-me";

test("free plan is capped at 1000 events/month", async () => {
  resetStoreForTests();
  const app = createApp();

  const site = "limit-free.local";

  for (let i = 0; i < 1000; i += 1) {
    await addEvent({
      site,
      category: "all",
      action: "accept_all",
      country: "CL",
    });
  }

  const blocked = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site,
      category: "all",
      action: "accept_all",
      country: "CL",
    });

  assert.equal(blocked.status, 402);
  assert.match(blocked.body.error, /Monthly event limit reached/i);
});

test("starter plan supports more than free event cap", async () => {
  resetStoreForTests();
  const app = createApp();

  const site = "limit-starter.local";
  await upsertSiteBilling(site, { plan: "starter", billingStatus: "active" });

  for (let i = 0; i < 1001; i += 1) {
    await addEvent({
      site,
      category: "all",
      action: "accept_all",
      country: "CL",
    });
  }

  const allowed = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site,
      category: "all",
      action: "accept_all",
      country: "CL",
    });

  assert.equal(allowed.status, 201);
});
