const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

const API_KEY = "dev-key-change-me";

test("POST /consent-events without API key returns 401", async () => {
  const app = createApp();
  const res = await request(app)
    .post("/consent-events")
    .send({ site: "demo.local", category: "analytics", action: "custom_preferences" });

  assert.equal(res.status, 401);
});

test("POST /consent-events with missing fields returns 400", async () => {
  const app = createApp();
  const res = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "demo.local" });

  assert.equal(res.status, 400);
});

test("POST /consent-events with invalid category returns 400", async () => {
  const app = createApp();
  const res = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "demo.local", category: "invalid", action: "custom_preferences" });

  assert.equal(res.status, 400);
});

test("POST /consent-events with invalid action returns 400", async () => {
  const app = createApp();
  const res = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "demo.local", category: "analytics", action: "invalid_action" });

  assert.equal(res.status, 400);
});

test("GET /consent-events with key in query is rejected", async () => {
  const app = createApp();
  const res = await request(app)
    .get("/consent-events")
    .query({ site: "demo.local", key: API_KEY });

  assert.equal(res.status, 401);
});

test("POST /consent-events with invalid site format returns 400", async () => {
  const app = createApp();
  const res = await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "bad..site", category: "analytics", action: "custom_preferences" });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid hostname-like/i);
});
