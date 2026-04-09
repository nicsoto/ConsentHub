const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createRateLimit } = require("../src/middleware/rateLimit");
const { resetStoreForTests } = require("../src/data/store");

test("rate limit middleware blocks after max requests and sets retry-after", async () => {
  resetStoreForTests();

  const app = express();
  app.use(createRateLimit({ windowMs: 60_000, max: 2, keyPrefix: "test:limit" }));
  app.get("/limited", (_req, res) => res.status(200).json({ ok: true }));

  const one = await request(app).get("/limited");
  const two = await request(app).get("/limited");
  const three = await request(app).get("/limited");

  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(three.status, 429);
  assert.match(three.headers["retry-after"], /^[1-9][0-9]*$/);
  assert.equal(three.body.error, "Too many requests");
});
