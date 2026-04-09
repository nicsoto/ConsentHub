const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const env = require("../src/config/env");
const { createApiCredential, resetStoreForTests } = require("../src/data/store");

test("db-scoped key allows only authorized site operations", async () => {
  resetStoreForTests();
  const app = createApp();

  await createApiCredential({
    key: "db-scoped-key-1",
    site: "tenant-a.local",
    scopes: ["ingest", "read", "export", "shops"],
  });

  const ingestOk = await request(app)
    .post("/consent-events")
    .set("x-api-key", "db-scoped-key-1")
    .send({
      site: "tenant-a.local",
      category: "analytics",
      action: "custom_preferences",
      country: "CL",
    });

  assert.equal(ingestOk.status, 201);

  const ingestForbidden = await request(app)
    .post("/consent-events")
    .set("x-api-key", "db-scoped-key-1")
    .send({
      site: "tenant-b.local",
      category: "analytics",
      action: "custom_preferences",
      country: "CL",
    });

  assert.equal(ingestForbidden.status, 403);

  const readForbidden = await request(app)
    .get("/consent-events")
    .set("x-api-key", "db-scoped-key-1")
    .query({ site: "tenant-b.local" });

  assert.equal(readForbidden.status, 403);

  const shopsScoped = await request(app)
    .get("/shops")
    .set("x-api-key", "db-scoped-key-1");

  assert.equal(shopsScoped.status, 200);
  assert.equal(shopsScoped.body.count, 1);
  assert.equal(shopsScoped.body.shops[0].site, "tenant-a.local");
});

test("legacy API key is rejected when ALLOW_LEGACY_API_KEYS=false", async () => {
  resetStoreForTests();
  const originalAllowLegacy = env.allowLegacyApiKeys;
  env.allowLegacyApiKeys = false;

  try {
    const app = createApp();
    const res = await request(app)
      .get("/shops")
      .set("x-api-key", "dev-key-change-me");

    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Legacy API keys are disabled");
  } finally {
    env.allowLegacyApiKeys = originalAllowLegacy;
  }
});
