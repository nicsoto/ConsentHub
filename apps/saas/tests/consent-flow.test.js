const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const { addEvent, resetStoreForTests, upsertSiteBilling } = require("../src/data/store");

const API_KEY = "dev-key-change-me";

test("consent flow: create -> list -> export csv", async () => {
  resetStoreForTests();
  const app = createApp();

  await upsertSiteBilling("demo.local", {
    plan: "starter",
    billingStatus: "active",
  });

  const created = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site: "demo.local",
      category: "analytics",
      action: "custom_preferences",
      country: "CL",
    });

  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.event.site, "demo.local");

  const listed = await request(app)
    .get("/consent-events")
    .set("x-api-key", API_KEY)
    .query({ site: "demo.local" });

  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.ok(listed.body.count >= 1);
  assert.equal(listed.body.events[0].site, "demo.local");

  const exported = await request(app)
    .get("/consent-events/export.csv")
    .set("x-api-key", API_KEY)
    .query({ site: "demo.local" });

  assert.equal(exported.status, 200);
  assert.match(exported.headers["content-type"], /text\/csv/);
  assert.match(exported.text, /timestamp,site,category,action,country/);
  assert.match(exported.text, /demo\.local/);
});

test("GET /shops returns created site", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site: "shop-a.local",
      category: "all",
      action: "accept_all",
      country: "CL",
    });

  const shops = await request(app)
    .get("/shops")
    .set("x-api-key", API_KEY);

  assert.equal(shops.status, 200);
  assert.equal(shops.body.ok, true);
  assert.ok(shops.body.count >= 1);
  assert.ok(shops.body.shops.some((s) => s.site === "shop-a.local"));
});

test("CSV export is blocked for free plan", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site: "free-export.local",
      category: "all",
      action: "accept_all",
      country: "CL",
    });

  const exported = await request(app)
    .get("/consent-events/export.csv")
    .set("x-api-key", API_KEY)
    .query({ site: "free-export.local" });

  assert.equal(exported.status, 402);
  assert.match(exported.body.error, /CSV export is not available/i);
});

test("Starter plan can export CSV and bypass free restrictions", async () => {
  resetStoreForTests();
  const app = createApp();

  await upsertSiteBilling("starter-export.local", {
    plan: "starter",
    billingStatus: "active",
  });

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site: "starter-export.local",
      category: "all",
      action: "accept_all",
      country: "CL",
    });

  const exported = await request(app)
    .get("/consent-events/export.csv")
    .set("x-api-key", API_KEY)
    .query({ site: "starter-export.local" });

  assert.equal(exported.status, 200);
  assert.match(exported.headers["content-type"], /text\/csv/);
});

test("consent ingestion uses configured default country when omitted", async () => {
  resetStoreForTests();
  const app = createApp();

  const created = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site: "country-default.local",
      category: "analytics",
      action: "custom_preferences",
    });

  assert.equal(created.status, 201);
  assert.equal(created.body.event.country, "CL");
});

test("consent ingestion rejects invalid country format", async () => {
  resetStoreForTests();
  const app = createApp();

  const created = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({
      site: "country-invalid.local",
      category: "analytics",
      action: "custom_preferences",
      country: "Chile",
    });

  assert.equal(created.status, 400);
  assert.match(created.body.error, /2-letter/i);
});

test("consent read endpoint enforces historyDays plan window", async () => {
  resetStoreForTests();
  const app = createApp();

  const originalNow = Date.now;
  try {
    Date.now = () => new Date("2025-01-01T00:00:00.000Z").getTime();
    await addEvent({
      site: "history-window.local",
      category: "all",
      action: "accept_all",
      country: "CL",
    });

    Date.now = () => new Date("2025-03-15T00:00:00.000Z").getTime();
    await addEvent({
      site: "history-window.local",
      category: "analytics",
      action: "custom_preferences",
      country: "CL",
    });

    const listed = await request(app)
      .get("/consent-events")
      .set("x-api-key", API_KEY)
      .query({ site: "history-window.local" });

    assert.equal(listed.status, 200);
    assert.equal(listed.body.count, 1);
    assert.equal(listed.body.events[0].category, "analytics");
  } finally {
    Date.now = originalNow;
  }
});
