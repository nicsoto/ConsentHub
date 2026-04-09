const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const { findShopBySite, resetStoreForTests } = require("../src/data/store");

test("public landing and plugin docs are available", async () => {
  resetStoreForTests();
  const app = createApp();

  const landing = await request(app).get("/");
  assert.equal(landing.status, 200);
  assert.match(landing.text, /ConsentHub/i);
  assert.match(landing.text, /Registro inmediato/i);

  const docs = await request(app).get("/docs/plugin-install");
  assert.equal(docs.status, 200);
  assert.match(docs.text, /Instalacion del plugin/i);
  assert.match(docs.text, /onboarding\/status/i);
});

test("public signup creates shop and owner policy flow", async () => {
  resetStoreForTests();
  const app = createApp();

  const signup = await request(app)
    .post("/signup")
    .type("form")
    .send({
      ownerEmail: "owner@ventas.local",
      site: "shop.ventas.local",
      plan: "starter",
      country: "CL",
    });

  assert.equal(signup.status, 200);
  assert.match(signup.text, /Cuenta creada/i);

  const shop = await findShopBySite("shop.ventas.local");
  assert.ok(shop);
  assert.equal(String(shop.plan), "starter");
});
