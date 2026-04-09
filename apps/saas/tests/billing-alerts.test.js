const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resetStoreForTests,
  createBillingAlert,
  getCriticalAlertsEligibleForEmail,
  getBillingMttrHours,
  listOpenBillingAlerts,
  markCriticalAlertsEmailSent,
  resolveBillingAlert,
  resolveOpenBillingAlertsBySiteAndType,
  runBillingAlertEscalation,
  upsertSiteBilling,
} = require("../src/data/store");

test("billing alerts can be created and listed as open", async () => {
  resetStoreForTests();

  await createBillingAlert({
    site: "alert.local",
    type: "payment_failed",
    severity: "warning",
    message: "Pago fallido en suscripcion",
    rawEventId: "evt_abc",
  });

  const open = await listOpenBillingAlerts(10);
  const ownOpen = open.filter((a) => a.site === "alert.local");
  assert.equal(ownOpen.length, 1);
  assert.equal(ownOpen[0].status, "open");
});

test("billing alerts can be resolved", async () => {
  resetStoreForTests();

  const created = await createBillingAlert({
    site: "alert-resolve.local",
    type: "payment_failed",
    severity: "warning",
    message: "Pago fallido en suscripcion",
  });

  const resolved = await resolveBillingAlert(created.id);
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.resolvedAt);

  const open = await listOpenBillingAlerts(10);
  const ownOpen = open.filter((a) => a.site === "alert-resolve.local");
  assert.equal(ownOpen.length, 0);
});

test("resolveOpenBillingAlertsBySiteAndType resolves only matching open alerts", async () => {
  resetStoreForTests();

  await createBillingAlert({
    site: "bulk.local",
    type: "payment_failed",
    severity: "warning",
    message: "falla 1",
  });
  await createBillingAlert({
    site: "bulk.local",
    type: "payment_failed",
    severity: "warning",
    message: "falla 2",
  });
  await createBillingAlert({
    site: "bulk.local",
    type: "payment_issue",
    severity: "warning",
    message: "otro tipo",
  });
  await createBillingAlert({
    site: "other.local",
    type: "payment_failed",
    severity: "warning",
    message: "otro sitio",
  });

  const resolved = await resolveOpenBillingAlertsBySiteAndType("bulk.local", "payment_failed");
  assert.equal(resolved, 2);

  const open = await listOpenBillingAlerts(20);
  const bulkFailedOpen = open.filter((a) => a.site === "bulk.local" && a.type === "payment_failed");
  const bulkOtherTypeOpen = open.filter((a) => a.site === "bulk.local" && a.type === "payment_issue");
  const otherSiteOpen = open.filter((a) => a.site === "other.local" && a.type === "payment_failed");

  assert.equal(bulkFailedOpen.length, 0);
  assert.equal(bulkOtherTypeOpen.length, 1);
  assert.equal(otherSiteOpen.length, 1);
});

test("expired grace escalates payment_failed alerts to critical", async () => {
  resetStoreForTests();

  await upsertSiteBilling("critical.local", {
    plan: "starter",
    billingStatus: "past_due",
    gracePeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });

  await createBillingAlert({
    site: "critical.local",
    type: "payment_failed",
    severity: "warning",
    message: "Pago fallido, revisar cobro",
  });

  const result = await runBillingAlertEscalation();
  assert.equal(result.escalatedCount, 1);
  assert.equal(result.escalatedAlerts.length, 1);
  assert.equal(result.escalatedAlerts[0].site, "critical.local");

  const open = await listOpenBillingAlerts(10);
  const ownOpen = open.filter((a) => a.site === "critical.local");
  assert.equal(ownOpen.length, 1);
  assert.equal(ownOpen[0].severity, "critical");
  assert.match(ownOpen[0].message, /CRITICO/);
});

test("billing MTTR is calculated from resolved incidents", async () => {
  resetStoreForTests();

  const created = await createBillingAlert({
    site: "mttr.local",
    type: "payment_failed",
    severity: "warning",
    message: "Cobro fallido",
  });

  assert.ok(created.id);
  await resolveBillingAlert(created.id);

  const mttr = await getBillingMttrHours(30);
  assert.ok(mttr.resolvedCount >= 1);
  assert.ok(mttr.mttrHours >= 0);
});

test("critical billing emails respect cooldown per site and alert type", async () => {
  resetStoreForTests();

  await upsertSiteBilling("cooldown.local", {
    plan: "starter",
    billingStatus: "past_due",
    gracePeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });

  await createBillingAlert({
    site: "cooldown.local",
    type: "payment_failed",
    severity: "warning",
    message: "Pago fallido, revisar cobro",
  });

  const result = await runBillingAlertEscalation();
  assert.equal(result.escalatedCount, 1);

  const firstBatch = await getCriticalAlertsEligibleForEmail(result.escalatedAlerts, 180, new Date("2026-01-01T10:00:00.000Z"));
  assert.equal(firstBatch.length, 1);

  const updatedCount = await markCriticalAlertsEmailSent(firstBatch, new Date("2026-01-01T10:00:00.000Z"));
  assert.equal(updatedCount, 1);

  await createBillingAlert({
    site: "cooldown.local",
    type: "payment_failed",
    severity: "warning",
    message: "Segundo pago fallido",
  });

  const secondEscalation = await runBillingAlertEscalation();
  assert.equal(secondEscalation.escalatedCount, 1);

  const suppressedBatch = await getCriticalAlertsEligibleForEmail(secondEscalation.escalatedAlerts, 180, new Date("2026-01-01T11:00:00.000Z"));
  assert.equal(suppressedBatch.length, 0);

  const secondBatch = await getCriticalAlertsEligibleForEmail(secondEscalation.escalatedAlerts, 180, new Date("2026-01-01T13:30:00.000Z"));
  assert.equal(secondBatch.length, 1);
});
