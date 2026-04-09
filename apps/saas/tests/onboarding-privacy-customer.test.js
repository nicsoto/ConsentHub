const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { createApp } = require("../src/app");
const { resetStoreForTests } = require("../src/data/store");

function extractDevMagicLink(html) {
  const match = String(html || "").match(/href="([^"]*\/auth\/verify\?token=[^"]+)"/i);
  return match ? match[1] : "";
}

test("onboarding creates site/owner, privacy endpoints work, and customer portal is usable", async () => {
  resetStoreForTests();
  const app = createApp();

  const onboarding = await request(app)
    .post("/onboarding/register")
    .send({
      site: "tenant-one.local",
      ownerEmail: "owner@tenant-one.local",
      plan: "starter",
      country: "CL",
    });

  assert.equal(onboarding.status, 201);
  assert.equal(onboarding.body.ok, true);
  assert.equal(onboarding.body.site, "tenant-one.local");
  assert.ok(String(onboarding.body.credential?.key || "").startsWith("ch_ing_"));

  const apiKey = onboarding.body.credential.key;

  const ingested = await request(app)
    .post("/consent-events")
    .set("x-api-key", apiKey)
    .send({
      site: "tenant-one.local",
      category: "analytics",
      action: "custom_preferences",
      country: "CL",
      subjectId: "subject-abc-001",
    });

  assert.equal(ingested.status, 201);

  const privacyData = await request(app)
    .get("/privacy/subjects/subject-abc-001/data")
    .set("x-api-key", apiKey)
    .query({ site: "tenant-one.local" });

  assert.equal(privacyData.status, 200);
  assert.equal(privacyData.body.count, 1);
  assert.equal(privacyData.body.events[0].subjectId, "subject-abc-001");

  const privacyDelete = await request(app)
    .delete("/privacy/subjects/subject-abc-001")
    .set("x-api-key", apiKey)
    .query({ site: "tenant-one.local" });

  assert.equal(privacyDelete.status, 200);
  assert.equal(privacyDelete.body.deletedCount, 1);

  const agent = request.agent(app);
  const requestLink = await agent
    .post("/auth/request-link")
    .type("form")
    .send({ email: "owner@tenant-one.local", _csrf: "" });

  assert.equal(requestLink.status, 403);

  const loginPage = await agent.get("/auth/login");
  assert.equal(loginPage.status, 200);
  const csrfMatch = String(loginPage.text).match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch);

  const requestLinkWithCsrf = await agent
    .post("/auth/request-link")
    .type("form")
    .send({ email: "owner@tenant-one.local", _csrf: csrfMatch[1] });

  assert.equal(requestLinkWithCsrf.status, 200);
  const devLink = extractDevMagicLink(requestLinkWithCsrf.text);
  assert.ok(devLink);

  const verify = await agent.get(devLink.replace("http://localhost:8787", ""));
  assert.equal(verify.status, 302);
  assert.equal(verify.headers.location, "/customer-portal");

  const portalData = await agent.get("/customer-portal/data");
  assert.equal(portalData.status, 200);
  assert.ok(Array.isArray(portalData.body.shops));
  assert.ok(portalData.body.shops.some((shop) => shop.site === "tenant-one.local"));

  const customerCsrf = portalData.body.csrfToken;
  assert.ok(customerCsrf);

  const createdCredential = await agent
    .post("/customer-portal/api-credentials/create")
    .send({ site: "tenant-one.local", profile: "read_export", _csrf: customerCsrf });

  assert.equal(createdCredential.status, 200);
  assert.ok(String(createdCredential.body.credential?.key || "").startsWith("ch_api_"));

  const refreshed = await agent.get("/customer-portal/data");
  assert.equal(refreshed.status, 200);
  const readExportCred = (refreshed.body.credentials || []).find(
    (cred) => String(cred.site || "") === "tenant-one.local" && Array.isArray(cred.scopes) && cred.scopes.includes("read")
  );
  assert.ok(readExportCred);

  const revoked = await agent
    .post(`/customer-portal/api-credentials/${encodeURIComponent(readExportCred.id)}/revoke`)
    .send({ _csrf: refreshed.body.csrfToken });

  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.ok, true);
});
