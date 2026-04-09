const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

test("POST /auth/request-link without CSRF returns 403", async () => {
  const app = createApp();
  const res = await request(app)
    .post("/auth/request-link")
    .type("form")
    .send({ email: "admin@consenthub.local" });

  assert.equal(res.status, 403);
});

test("POST /auth/request-link with valid CSRF returns 200", async () => {
  const app = createApp();
  const login = await request(app).get("/auth/login");

  const csrfMatch = login.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should exist in login form");

  const csrf = csrfMatch[1];
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie, "CSRF cookie should be set");

  const res = await request(app)
    .post("/auth/request-link")
    .set("Cookie", cookie)
    .type("form")
    .send({ email: "admin@consenthub.local", _csrf: csrf });

  assert.equal(res.status, 200);
});
