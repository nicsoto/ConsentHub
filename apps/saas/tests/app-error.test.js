const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

test("invalid JSON returns 400 with requestId and mirrors x-request-id header", async () => {
  const app = createApp();
  const reqId = "req-error-123";

  const res = await request(app)
    .post("/consent-events")
    .set("x-api-key", "dev-key-change-me")
    .set("x-request-id", reqId)
    .set("Content-Type", "application/json")
    .send('{"invalidJson":');

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Invalid JSON payload");
  assert.equal(res.body.requestId, reqId);
  assert.equal(res.headers["x-request-id"], reqId);
});
