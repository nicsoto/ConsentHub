const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const env = require("../src/config/env");
const { createSessionValue } = require("../src/services/session");
const { resetWorkerJobsStatusForTests } = require("../src/services/workerJobStatus");
const {
  createAuditLog,
  createBillingAlert,
    createApiCredential,
  findActiveApiCredentialByKey,
  listApiCredentials,
  listAuditLogs,
  resetStoreForTests,
  resolveBillingAlert,
} = require("../src/data/store");

const API_KEY = "dev-key-change-me";

function cookieHeaderFrom(setCookie = []) {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function loginAndGetSession(app) {
  const login = await request(app).get("/auth/login");
  const csrfMatch = login.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should exist in login form");

  const csrf = csrfMatch[1];
  const baseCookies = cookieHeaderFrom(login.headers["set-cookie"] || []);

  const reqLink = await request(app)
    .post("/auth/request-link")
    .set("Cookie", baseCookies)
    .type("form")
    .send({ email: "admin@consenthub.local", _csrf: csrf });

  assert.equal(reqLink.status, 200);

  const tokenMatch = reqLink.text.match(/\/auth\/verify\?token=([a-f0-9]+)/);
  assert.ok(tokenMatch, "Magic link token should be present in response");

  const verify = await request(app).get(`/auth/verify?token=${tokenMatch[1]}`);
  assert.equal(verify.status, 302);

  const sessionCookies = cookieHeaderFrom(verify.headers["set-cookie"] || []);

  const merged = [baseCookies, sessionCookies].filter(Boolean).join("; ");
  return { cookie: merged };
}

async function getCsrfContext(app) {
  const login = await request(app).get("/auth/login");
  const csrfMatch = login.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should exist in login form");
  const csrf = csrfMatch[1];
  const cookies = cookieHeaderFrom(login.headers["set-cookie"] || []);
  return { csrf, cookies };
}

function scopedSessionCookie({ email, role, sites, baseCookies }) {
  const raw = createSessionValue(email, env.sessionSecret, { role, sites });
  const sessionCookie = `consenthub_session=${encodeURIComponent(raw)}`;
  return [baseCookies, sessionCookie].filter(Boolean).join("; ");
}

test("dashboard shows filtered metrics and data", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "site-a.local", category: "analytics", action: "custom_preferences", country: "CL" });

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "site-a.local", category: "all", action: "accept_all", country: "CL" });

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "site-b.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);

  const res = await request(app)
    .get("/dashboard")
    .set("Cookie", auth.cookie)
    .query({ site: "site-a.local", days: 90, limit: 50 });

  assert.equal(res.status, 200);
  assert.match(res.text, /ConsentHub Dashboard/);
  assert.match(res.text, /Eventos \(filtro actual\)/);
  assert.match(res.text, /Eventos \(filtro actual\)<\/div>\s*<div class="value">2<\/div>/);
  assert.match(res.text, /site-a\.local/);
  assert.match(res.text, /value="site-a\.local"/);
});

test("dashboard retention update requires csrf", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "ret.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);

  const res = await request(app)
    .post("/dashboard/retention")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "ret.local", retentionDays: 45 });

  assert.equal(res.status, 403);
});

test("dashboard retention update succeeds with csrf", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "ret-ok.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);

  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  assert.equal(dashboard.status, 200);

  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should be present in dashboard form");

  const res = await request(app)
    .post("/dashboard/retention")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "ret-ok.local", retentionDays: 45, _csrf: csrfMatch[1] });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /Retencion\+actualizada/);

  const updated = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  assert.equal(updated.status, 200);
  assert.match(updated.text, /45 dias/);

  const logs = await listAuditLogs({
    site: "ret-ok.local",
    action: "dashboard.retention.update",
    limit: 10,
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actorEmail, "admin@consenthub.local");
  assert.equal(logs[0].site, "ret-ok.local");
  assert.equal(logs[0].requestId, res.headers["x-request-id"]);
});

test("dashboard incidents export requires authenticated session", async () => {
  resetStoreForTests();
  resetWorkerJobsStatusForTests();
  const app = createApp();

  const res = await request(app).get("/dashboard/incidents/export");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/auth/login");

  const auditRes = await request(app).get("/dashboard/audit-logs");
  assert.equal(auditRes.status, 302);
  assert.equal(auditRes.headers.location, "/auth/login");

  const auditCsvRes = await request(app).get("/dashboard/audit-logs.csv");
  assert.equal(auditCsvRes.status, 302);
  assert.equal(auditCsvRes.headers.location, "/auth/login");

  const opsConfigRes = await request(app).get("/dashboard/ops-config");
  assert.equal(opsConfigRes.status, 302);
  assert.equal(opsConfigRes.headers.location, "/auth/login");

  const workerStatusRes = await request(app).get("/dashboard/worker-jobs-status");
  assert.equal(workerStatusRes.status, 302);
  assert.equal(workerStatusRes.headers.location, "/auth/login");

  const workerHistoryRes = await request(app).get("/dashboard/worker-jobs-history");
  assert.equal(workerHistoryRes.status, 302);
  assert.equal(workerHistoryRes.headers.location, "/auth/login");

  const workerHistoryCsvRes = await request(app).get("/dashboard/worker-jobs-history.csv");
  assert.equal(workerHistoryCsvRes.status, 302);
  assert.equal(workerHistoryCsvRes.headers.location, "/auth/login");

  const dashboardV2Res = await request(app).get("/dashboard-v2");
  assert.equal(dashboardV2Res.status, 302);
  assert.equal(dashboardV2Res.headers.location, "/auth/login");

  const dashboardV2DataRes = await request(app).get("/dashboard-v2/data");
  assert.equal(dashboardV2DataRes.status, 302);
  assert.equal(dashboardV2DataRes.headers.location, "/auth/login");
});

test("dashboard-v2 loads separated frontend and data endpoint", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "v2.local", category: "analytics", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);

  const uiRes = await request(app)
    .get("/dashboard-v2")
    .set("Cookie", auth.cookie);

  assert.equal(uiRes.status, 200);
  assert.match(uiRes.text, /Dashboard V2/);
  assert.match(uiRes.text, /\/dashboard-v2\/assets\/app\.js/);

  const dataRes = await request(app)
    .get("/dashboard-v2/data")
    .set("Cookie", auth.cookie)
    .query({ site: "v2.local", days: 30, limit: 50 });

  assert.equal(dataRes.status, 200);
  assert.equal(dataRes.body.filters.site, "v2.local");
  assert.equal(typeof dataRes.body.summary.eventsCount, "number");
  assert.ok(Array.isArray(dataRes.body.topShops));
  assert.ok(Array.isArray(dataRes.body.recentEvents));
});

test("dashboard-v2 mutable endpoints enforce csrf", async () => {
  resetStoreForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  const res = await request(app)
    .post("/dashboard-v2/retention")
    .set("Cookie", auth.cookie)
    .send({ site: "csrf-v2.local", retentionDays: 40 });

  assert.equal(res.status, 403);
});

test("dashboard-v2 can update retention and manage api credentials", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "ops-v2.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);
  const dataRes = await request(app)
    .get("/dashboard-v2/data")
    .set("Cookie", auth.cookie);

  assert.equal(dataRes.status, 200);
  assert.equal(typeof dataRes.body.csrfToken, "string");
  assert.ok(dataRes.body.csrfToken.length > 10);

  const csrf = dataRes.body.csrfToken;

  const retentionRes = await request(app)
    .post("/dashboard-v2/retention")
    .set("Cookie", auth.cookie)
    .send({ site: "ops-v2.local", retentionDays: 65, _csrf: csrf });

  assert.equal(retentionRes.status, 200);
  assert.equal(retentionRes.body.ok, true);

  const createRes = await request(app)
    .post("/dashboard-v2/api-credentials/create")
    .set("Cookie", auth.cookie)
    .send({ site: "ops-v2.local", profile: "read_export", _csrf: csrf });

  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.ok, true);
  assert.equal(createRes.body.credential.site, "ops-v2.local");
  assert.ok(String(createRes.body.credential.key || "").startsWith("ch_api_"));

  const credentials = await listApiCredentials({ site: "ops-v2.local", status: "active", limit: 20 });
  assert.ok(credentials.length >= 1);

  const revokeTarget = credentials[0];
  const revokeRes = await request(app)
    .post(`/dashboard-v2/api-credentials/${encodeURIComponent(revokeTarget.id)}/revoke`)
    .set("Cookie", auth.cookie)
    .send({ _csrf: csrf });

  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.body.ok, true);

  const regenRes = await request(app)
    .post("/dashboard-v2/api-credentials/regenerate-ingest")
    .set("Cookie", auth.cookie)
    .send({ site: "ops-v2.local", _csrf: csrf });

  assert.equal(regenRes.status, 200);
  assert.equal(regenRes.body.ok, true);
  assert.equal(regenRes.body.credential.site, "ops-v2.local");
  assert.ok(String(regenRes.body.credential.key || "").startsWith("ch_ing_"));
});

test("dashboard-v2 enforces RBAC permissions", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "rbac.local", category: "all", action: "accept_all", country: "CL" });

  const { csrf, cookies } = await getCsrfContext(app);
  const analystCookie = scopedSessionCookie({
    email: "analyst@consenthub.local",
    role: "analyst",
    sites: ["rbac.local"],
    baseCookies: cookies,
  });

  const forbidden = await request(app)
    .post("/dashboard-v2/api-credentials/create")
    .set("Cookie", analystCookie)
    .send({ site: "rbac.local", profile: "ingest", _csrf: csrf });

  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, "Forbidden");
});

test("dashboard-v2 enforces site scope for mutable operations", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "scope-allowed.local", category: "all", action: "accept_all", country: "CL" });

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "scope-denied.local", category: "all", action: "accept_all", country: "CL" });

  const { csrf, cookies } = await getCsrfContext(app);
  const operatorCookie = scopedSessionCookie({
    email: "operator@consenthub.local",
    role: "operator",
    sites: ["scope-allowed.local"],
    baseCookies: cookies,
  });

  const allowed = await request(app)
    .post("/dashboard-v2/retention")
    .set("Cookie", operatorCookie)
    .send({ site: "scope-allowed.local", retentionDays: 99, _csrf: csrf });

  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);

  const denied = await request(app)
    .post("/dashboard-v2/retention")
    .set("Cookie", operatorCookie)
    .send({ site: "scope-denied.local", retentionDays: 99, _csrf: csrf });

  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "Sin acceso al sitio");
});

test("dashboard-v2 access policy management is admin-only", async () => {
  resetStoreForTests();
  const app = createApp();

  const { csrf, cookies } = await getCsrfContext(app);

  const adminCookie = scopedSessionCookie({
    email: "admin@consenthub.local",
    role: "admin",
    sites: ["*"],
    baseCookies: cookies,
  });

  const upsertRes = await request(app)
    .post("/dashboard-v2/access-policies/upsert")
    .set("Cookie", adminCookie)
    .send({
      email: "analyst@tenant.local",
      role: "analyst",
      sites: ["tenant.local"],
      _csrf: csrf,
    });

  assert.equal(upsertRes.status, 200);
  assert.equal(upsertRes.body.ok, true);

  const listRes = await request(app)
    .get("/dashboard-v2/access-policies")
    .set("Cookie", adminCookie);

  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body.policies));
  assert.ok(listRes.body.policies.some((row) => row.email === "analyst@tenant.local"));

  const analystCookie = scopedSessionCookie({
    email: "analyst@tenant.local",
    role: "analyst",
    sites: ["tenant.local"],
    baseCookies: cookies,
  });

  const forbidden = await request(app)
    .get("/dashboard-v2/access-policies")
    .set("Cookie", analystCookie);

  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, "Forbidden");
});

test("classic dashboard retention route enforces site scope (no legacy bypass)", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "legacy-allowed.local", category: "all", action: "accept_all", country: "CL" });

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "legacy-denied.local", category: "all", action: "accept_all", country: "CL" });

  const { csrf, cookies } = await getCsrfContext(app);
  const scopedCookie = scopedSessionCookie({
    email: "operator@tenant.local",
    role: "operator",
    sites: ["legacy-allowed.local"],
    baseCookies: cookies,
  });

  const denied = await request(app)
    .post("/dashboard/retention")
    .set("Cookie", scopedCookie)
    .type("form")
    .send({ site: "legacy-denied.local", retentionDays: 111, _csrf: csrf });

  assert.equal(denied.status, 302);
  assert.match(String(denied.headers.location || ""), /Sin\+acceso\+al\+sitio/);
});

test("classic dashboard credentials route enforces role permissions", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "legacy-cred.local", category: "all", action: "accept_all", country: "CL" });

  const { csrf, cookies } = await getCsrfContext(app);
  const analystCookie = scopedSessionCookie({
    email: "analyst@tenant.local",
    role: "analyst",
    sites: ["legacy-cred.local"],
    baseCookies: cookies,
  });

  const denied = await request(app)
    .post("/dashboard/api-credentials/create")
    .set("Cookie", analystCookie)
    .type("form")
    .send({ site: "legacy-cred.local", profile: "ingest", _csrf: csrf });

  assert.equal(denied.status, 302);
  assert.match(String(denied.headers.location || ""), /No\+tienes\+permiso\+para\+credenciales/);
});

test("dashboard ops-config endpoint returns effective non-secret settings", async () => {
  resetStoreForTests();
  resetWorkerJobsStatusForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  const res = await request(app)
    .get("/dashboard/ops-config")
    .set("Cookie", auth.cookie);

  assert.equal(res.status, 200);
  assert.ok(["web", "worker", "all"].includes(res.body.appRole));
  assert.equal(typeof res.body.nodeEnv, "string");

  assert.equal(typeof res.body.readiness, "object");
  assert.equal(typeof res.body.readiness.checkStripe, "boolean");
  assert.equal(typeof res.body.readiness.dbTimeoutMs, "number");
  assert.equal(typeof res.body.readiness.stripeTimeoutMs, "number");
  assert.equal(res.body.readiness.dbTimeoutMs, env.readinessDbTimeoutMs);
  assert.equal(res.body.readiness.stripeTimeoutMs, env.readinessStripeTimeoutMs);

  assert.equal(typeof res.body.auditLogsRateLimit, "object");
  assert.equal(typeof res.body.auditLogsRateLimit.windowMs, "number");
  assert.equal(typeof res.body.auditLogsRateLimit.max, "number");
  assert.equal(res.body.auditLogsRateLimit.windowMs, env.auditLogsRateLimitWindowMs);
  assert.equal(res.body.auditLogsRateLimit.max, env.auditLogsRateLimitMax);
});

test("dashboard worker jobs status endpoint returns local job runtime state", async () => {
  resetStoreForTests();
  resetWorkerJobsStatusForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  const res = await request(app)
    .get("/dashboard/worker-jobs-status")
    .set("Cookie", auth.cookie);

  assert.equal(res.status, 200);
  assert.ok(["web", "worker", "all"].includes(res.body.appRole));
  assert.equal(typeof res.body.jobsInThisProcess, "boolean");
  assert.equal(typeof res.body.totalJobs, "number");
  assert.ok(Array.isArray(res.body.jobs));
});

test("dashboard worker jobs history endpoint returns persisted entries", async () => {
  resetStoreForTests();
  resetWorkerJobsStatusForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  await createAuditLog({
    actorEmail: "system@worker.local",
    action: "worker.job.retention.success",
    metadata: { durationMs: 123, deletedTotal: 2 },
  });

  await createAuditLog({
    actorEmail: "system@worker.local",
    action: "worker.job.retention.error",
    metadata: { durationMs: 200, errorMessage: "boom" },
  });

  const res = await request(app)
    .get("/dashboard/worker-jobs-history")
    .set("Cookie", auth.cookie)
    .query({ job: "retention", limit: 10 });

  assert.equal(res.status, 200);
  assert.equal(res.body.filters.job, "retention");
  assert.equal(res.body.total, 2);
  assert.ok(Array.isArray(res.body.history));
  assert.equal(res.body.history[0].actorEmail, "system@worker.local");
  assert.equal(typeof res.body.nextCursor, "string");
});

test("dashboard worker jobs history supports cursor pagination", async () => {
  resetStoreForTests();
  resetWorkerJobsStatusForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  await createAuditLog({
    actorEmail: "system@worker.local",
    action: "worker.job.retention.success",
    metadata: { durationMs: 10 },
  });

  await createAuditLog({
    actorEmail: "system@worker.local",
    action: "worker.job.retention.error",
    metadata: { durationMs: 20 },
  });

  const page1 = await request(app)
    .get("/dashboard/worker-jobs-history")
    .set("Cookie", auth.cookie)
    .query({ job: "retention", limit: 1 });

  assert.equal(page1.status, 200);
  assert.equal(page1.body.total, 1);
  assert.equal(page1.body.history.length, 1);
  assert.equal(typeof page1.body.nextCursor, "string");
  assert.ok(page1.body.nextCursor.length > 0);

  const page2 = await request(app)
    .get("/dashboard/worker-jobs-history")
    .set("Cookie", auth.cookie)
    .query({ job: "retention", limit: 1, cursor: page1.body.nextCursor });

  assert.equal(page2.status, 200);
  assert.equal(page2.body.total, 1);
  assert.equal(page2.body.history.length, 1);
  assert.notEqual(page2.body.history[0].id, page1.body.history[0].id);
});

test("dashboard worker jobs history endpoint validates filters", async () => {
  resetStoreForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  const badJob = await request(app)
    .get("/dashboard/worker-jobs-history")
    .set("Cookie", auth.cookie)
    .query({ job: "unknown-job" });

  assert.equal(badJob.status, 400);
  assert.equal(badJob.body.error, "Job invalido");

  const badStatus = await request(app)
    .get("/dashboard/worker-jobs-history")
    .set("Cookie", auth.cookie)
    .query({ status: "warn" });

  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.body.error, "Status invalido");

  const badCursor = await request(app)
    .get("/dashboard/worker-jobs-history")
    .set("Cookie", auth.cookie)
    .query({ cursor: "%%%bad%%%" });

  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.error, "Cursor de historial invalido");
});

test("dashboard audit logs endpoint returns filtered entries", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "audit.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);
  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch);

  await request(app)
    .post("/dashboard/retention")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "audit.local", retentionDays: 30, _csrf: csrfMatch[1] });

  const res = await request(app)
    .get("/dashboard/audit-logs")
    .set("Cookie", auth.cookie)
    .query({ site: "audit.local", action: "dashboard.retention.update", limit: 20 });

  assert.equal(res.status, 200);
  assert.equal(res.body.filters.site, "audit.local");
  assert.equal(res.body.filters.action, "dashboard.retention.update");
  assert.equal(res.body.total, 1);
  assert.equal(res.body.logs[0].actorEmail, "admin@consenthub.local");
  assert.equal(res.body.logs[0].site, "audit.local");
  assert.equal(res.body.logs[0].action, "dashboard.retention.update");
});

test("dashboard audit logs endpoint supports cursor pagination", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "audit-cursor.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);
  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch);

  await request(app)
    .post("/dashboard/retention")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "audit-cursor.local", retentionDays: 30, _csrf: csrfMatch[1] });

  await request(app)
    .post("/dashboard/retention")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "audit-cursor.local", retentionDays: 31, _csrf: csrfMatch[1] });

  const page1 = await request(app)
    .get("/dashboard/audit-logs")
    .set("Cookie", auth.cookie)
    .query({ site: "audit-cursor.local", action: "dashboard.retention.update", limit: 1 });

  assert.equal(page1.status, 200);
  assert.equal(page1.body.total, 1);
  assert.equal(page1.body.logs.length, 1);
  assert.equal(typeof page1.body.nextCursor, "string");
  assert.ok(page1.body.nextCursor.length > 0);

  const page2 = await request(app)
    .get("/dashboard/audit-logs")
    .set("Cookie", auth.cookie)
    .query({
      site: "audit-cursor.local",
      action: "dashboard.retention.update",
      limit: 1,
      cursor: page1.body.nextCursor,
    });

  assert.equal(page2.status, 200);
  assert.equal(page2.body.total, 1);
  assert.equal(page2.body.logs.length, 1);
  assert.notEqual(page2.body.logs[0].id, page1.body.logs[0].id);
});

test("dashboard audit logs endpoint rejects invalid cursor", async () => {
  resetStoreForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  const res = await request(app)
    .get("/dashboard/audit-logs")
    .set("Cookie", auth.cookie)
    .query({ cursor: "not-a-valid-cursor@@@" });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Cursor de auditoria invalido");
});

test("dashboard audit and worker history endpoints share rate-limit budget", async () => {
  resetStoreForTests();
  const originalMax = env.auditLogsRateLimitMax;
  const originalWindowMs = env.auditLogsRateLimitWindowMs;
  env.auditLogsRateLimitMax = 3;
  env.auditLogsRateLimitWindowMs = 60_000;

  const app = createApp();
  const auth = await loginAndGetSession(app);

  try {
    const ok1 = await request(app)
      .get("/dashboard/audit-logs")
      .set("Cookie", auth.cookie)
      .query({ limit: 1 });
    assert.equal(ok1.status, 200);

    const ok2 = await request(app)
      .get("/dashboard/worker-jobs-history")
      .set("Cookie", auth.cookie)
      .query({ limit: 1 });
    assert.equal(ok2.status, 200);

    const ok3 = await request(app)
      .get("/dashboard/worker-jobs-history.csv")
      .set("Cookie", auth.cookie)
      .query({ limit: 1 });
    assert.equal(ok3.status, 200);

    const blocked = await request(app)
      .get("/dashboard/audit-logs")
      .set("Cookie", auth.cookie)
      .query({ limit: 1 });

    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "Too many requests");
    assert.match(String(blocked.headers["retry-after"] || ""), /^[1-9][0-9]*$/);
  } finally {
    env.auditLogsRateLimitMax = originalMax;
    env.auditLogsRateLimitWindowMs = originalWindowMs;
  }
});

test("dashboard worker jobs history csv export returns csv with filters", async () => {
  resetStoreForTests();
  resetWorkerJobsStatusForTests();
  const app = createApp();
  const auth = await loginAndGetSession(app);

  await createAuditLog({
    actorEmail: "system@worker.local",
    action: "worker.job.retention.success",
    metadata: { durationMs: 150 },
  });

  await createAuditLog({
    actorEmail: "system@worker.local",
    action: "worker.job.billing_alerts.error",
    metadata: { durationMs: 200, errorMessage: "downstream timeout" },
  });

  const csvRes = await request(app)
    .get("/dashboard/worker-jobs-history.csv")
    .set("Cookie", auth.cookie)
    .query({ job: "billing-alerts", status: "error", limit: 50 });

  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers["content-type"], /text\/csv/);
  assert.match(csvRes.text, /createdAt,job,status,actorEmail,site,requestId,durationMs,errorMessage,metadata/);
  assert.match(csvRes.text, /billing_alerts/);
  assert.match(csvRes.text, /downstream timeout/);
  assert.doesNotMatch(csvRes.text, /retention/);
});

test("dashboard audit logs csv export returns csv with filters", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "audit-csv.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);
  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch);

  await request(app)
    .post("/dashboard/retention")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "audit-csv.local", retentionDays: 33, _csrf: csrfMatch[1] });

  const csvRes = await request(app)
    .get("/dashboard/audit-logs.csv")
    .set("Cookie", auth.cookie)
    .query({ site: "audit-csv.local", action: "dashboard.retention.update", limit: 50 });

  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers["content-type"], /text\/csv/);
  assert.match(csvRes.text, /createdAt,actorEmail,action,site,requestId,metadata/);
  assert.match(csvRes.text, /audit-csv\.local/);
  assert.match(csvRes.text, /dashboard\.retention\.update/);
});

test("dashboard incidents export supports json and csv filters", async () => {
  resetStoreForTests();
  const app = createApp();

  const a = await createBillingAlert({
    site: "inc-a.local",
    type: "payment_failed",
    severity: "warning",
    message: "Primer incidente",
  });

  const b = await createBillingAlert({
    site: "inc-b.local",
    type: "payment_failed",
    severity: "critical",
    message: "Segundo incidente",
  });

  assert.ok(a.id && b.id);
  await resolveBillingAlert(a.id);

  const auth = await loginAndGetSession(app);

  const jsonRes = await request(app)
    .get("/dashboard/incidents/export")
    .set("Cookie", auth.cookie)
    .query({ status: "resolved", site: "inc-a.local", days: 30, limit: 100 });

  assert.equal(jsonRes.status, 200);
  assert.equal(jsonRes.body.total, 1);
  assert.equal(jsonRes.body.filters.site, "inc-a.local");
  assert.equal(jsonRes.body.filters.status, "resolved");
  assert.equal(jsonRes.body.incidents[0].site, "inc-a.local");

  const csvRes = await request(app)
    .get("/dashboard/incidents/export.csv")
    .set("Cookie", auth.cookie)
    .query({ status: "open", days: 30, limit: 100 });

  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers["content-type"], /text\/csv/);
  assert.match(csvRes.text, /createdAt,site,type,status,severity,message,resolvedAt,rawEventId/);
  assert.match(csvRes.text, /inc-b\.local/);
  assert.doesNotMatch(csvRes.text, /inc-a\.local/);
});

test("dashboard can create scoped API credential for a site", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "cred-create.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);
  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch);

  const created = await request(app)
    .post("/dashboard/api-credentials/create")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "cred-create.local", profile: "ingest", _csrf: csrfMatch[1] });

  assert.equal(created.status, 200);
  assert.match(created.text, /Credencial creada/);
  assert.match(created.text, /ch_ing_[a-f0-9]+/);

  const keyMatch = created.text.match(/ch_ing_[a-f0-9]+/);
  assert.ok(keyMatch);

  const stored = await findActiveApiCredentialByKey(keyMatch[0]);
  assert.ok(stored);
  assert.equal(stored.site, "cred-create.local");
  assert.deepEqual(stored.scopes, ["ingest"]);
});

test("dashboard can revoke API credential", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "cred-revoke.local", category: "all", action: "accept_all", country: "CL" });

  const auth = await loginAndGetSession(app);
  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch);

  const created = await request(app)
    .post("/dashboard/api-credentials/create")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "cred-revoke.local", profile: "ingest", _csrf: csrfMatch[1] });

  const keyMatch = created.text.match(/ch_ing_[a-f0-9]+/);
  assert.ok(keyMatch);

  const activeBefore = await listApiCredentials({ site: "cred-revoke.local", status: "active", limit: 20 });
  assert.equal(activeBefore.length, 1);

  const revoke = await request(app)
    .post(`/dashboard/api-credentials/${activeBefore[0].id}/revoke`)
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ _csrf: csrfMatch[1] });

  assert.equal(revoke.status, 302);
  assert.match(revoke.headers.location, /Credencial\+revocada/);

  const activeAfter = await listApiCredentials({ site: "cred-revoke.local", status: "active", limit: 20 });
  assert.equal(activeAfter.length, 0);
});

test("dashboard can regenerate ingest key and revoke previous ingest credentials", async () => {
  resetStoreForTests();
  const app = createApp();

  await request(app)
    .post("/consent-events")
    .set("x-api-key", API_KEY)
    .send({ site: "cred-rotate.local", category: "all", action: "accept_all", country: "CL" });

  await createApiCredential({
    key: "ch_ing_old001",
    site: "cred-rotate.local",
    scopes: ["ingest"],
    status: "active",
  });

  await createApiCredential({
    key: "ch_api_keep001",
    site: "cred-rotate.local",
    scopes: ["read", "export"],
    status: "active",
  });

  const auth = await loginAndGetSession(app);
  const dashboard = await request(app).get("/dashboard").set("Cookie", auth.cookie);
  const csrfMatch = dashboard.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch);

  const rotated = await request(app)
    .post("/dashboard/api-credentials/regenerate-ingest")
    .set("Cookie", auth.cookie)
    .type("form")
    .send({ site: "cred-rotate.local", _csrf: csrfMatch[1] });

  assert.equal(rotated.status, 200);
  assert.match(rotated.text, /Key Ingest regenerada/);
  assert.match(rotated.text, /ch_ing_[a-f0-9]+/);

  const active = await listApiCredentials({ site: "cred-rotate.local", status: "active", limit: 20 });
  const ingestActive = active.filter((cred) => Array.isArray(cred.scopes) && cred.scopes.length === 1 && cred.scopes[0] === "ingest");
  const readExportActive = active.filter((cred) => Array.isArray(cred.scopes) && cred.scopes.includes("read") && cred.scopes.includes("export"));

  assert.equal(ingestActive.length, 1);
  assert.equal(readExportActive.length, 1);
  assert.match(String(readExportActive[0].keyFingerprint || ""), /^sha256:[a-f0-9]{12}$/);
});
