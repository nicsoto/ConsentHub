const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const stripeService = require("../src/services/stripeClient");
const {
  resetStoreForTests,
  upsertSiteBilling,
  getSiteBilling,
  listOpenBillingAlerts,
  hasProcessedBillingWebhookEvent,
} = require("../src/data/store");

function createAppWithMockedStripe(eventFactory) {
  const originalHasConfig = stripeService.hasStripeBillingConfig;
  const originalGetStripeClient = stripeService.getStripeClient;

  stripeService.hasStripeBillingConfig = () => true;
  stripeService.getStripeClient = () => ({
    webhooks: {
      constructEvent: (rawBody, signature) => eventFactory({ rawBody, signature }),
    },
  });

  const billingRoutePath = require.resolve("../src/routes/billing");
  const appPath = require.resolve("../src/app");
  delete require.cache[billingRoutePath];
  delete require.cache[appPath];

  const { createApp } = require("../src/app");
  const app = createApp();

  return {
    app,
    restore: () => {
      stripeService.hasStripeBillingConfig = originalHasConfig;
      stripeService.getStripeClient = originalGetStripeClient;
      delete require.cache[billingRoutePath];
      delete require.cache[appPath];
    },
  };
}

test("invoice.payment_failed transitions site to past_due, creates alert and supports idempotency", async () => {
  resetStoreForTests();

  await upsertSiteBilling("webhook.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_webhook_1",
    stripeSubscriptionId: "sub_webhook_1",
  });

  const payload = {
    id: "evt_payment_failed_1",
    type: "invoice.payment_failed",
    data: {
      object: {
        customer: "cus_webhook_1",
        subscription: "sub_webhook_1",
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(({ rawBody, signature }) => {
    assert.equal(typeof signature, "string");
    assert.ok(Buffer.isBuffer(rawBody));
    return payload;
  });

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_test_1")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    assert.equal(first.body.duplicate, undefined);

    const billing = await getSiteBilling("webhook.local");
    assert.equal(billing.billingStatus, "past_due");
    assert.equal(billing.plan, "starter");
    assert.ok(billing.gracePeriodEndsAt);

    const alerts = (await listOpenBillingAlerts(20)).filter((a) => a.site === "webhook.local");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "payment_failed");
    assert.equal(alerts[0].rawEventId, payload.id);

    const processed = await hasProcessedBillingWebhookEvent("stripe", payload.id);
    assert.equal(processed, true);

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_test_1")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);

    const alertsAfterDuplicate = (await listOpenBillingAlerts(20)).filter((a) => a.site === "webhook.local");
    assert.equal(alertsAfterDuplicate.length, 1);
  } finally {
    restore();
  }
});

test("invoice.payment_failed with unknown customer is a safe no-op and still idempotent", async () => {
  resetStoreForTests();

  await upsertSiteBilling("unrelated.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_unrelated_1",
    stripeSubscriptionId: "sub_unrelated_1",
  });

  const payload = {
    id: "evt_payment_failed_unknown_1",
    type: "invoice.payment_failed",
    data: {
      object: {
        customer: "cus_not_found",
        subscription: "sub_not_found",
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_unknown_customer")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    assert.equal(first.body.duplicate, undefined);

    const processed = await hasProcessedBillingWebhookEvent("stripe", payload.id);
    assert.equal(processed, true);

    const alerts = await listOpenBillingAlerts(20);
    assert.equal(alerts.length, 0);

    const unrelated = await getSiteBilling("unrelated.local");
    assert.equal(unrelated.billingStatus, "active");
    assert.equal(unrelated.plan, "starter");
    assert.equal(unrelated.gracePeriodEndsAt, null);

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_unknown_customer")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);
  } finally {
    restore();
  }
});

test("invoice.payment_succeeded recovers site from past_due to active and clears grace period", async () => {
  resetStoreForTests();

  await upsertSiteBilling("recovery.local", {
    plan: "pro",
    billingStatus: "past_due",
    stripeCustomerId: "cus_recovery_1",
    stripeSubscriptionId: "sub_recovery_old",
    gracePeriodEndsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const payload = {
    id: "evt_payment_succeeded_1",
    type: "invoice.payment_succeeded",
    data: {
      object: {
        customer: "cus_recovery_1",
        subscription: "sub_recovery_new",
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_payment_succeeded")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    assert.equal(first.body.duplicate, undefined);

    const billing = await getSiteBilling("recovery.local");
    assert.equal(billing.plan, "pro");
    assert.equal(billing.billingStatus, "active");
    assert.equal(billing.stripeSubscriptionId, "sub_recovery_new");
    assert.equal(billing.gracePeriodEndsAt, null);

    const processed = await hasProcessedBillingWebhookEvent("stripe", payload.id);
    assert.equal(processed, true);

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_payment_succeeded")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);
  } finally {
    restore();
  }
});

test("invoice.paid recovers site from past_due to active and clears grace period", async () => {
  resetStoreForTests();

  await upsertSiteBilling("recovery-paid.local", {
    plan: "starter",
    billingStatus: "past_due",
    stripeCustomerId: "cus_recovery_paid_1",
    stripeSubscriptionId: "sub_recovery_paid_old",
    gracePeriodEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const payload = {
    id: "evt_invoice_paid_recovery_1",
    type: "invoice.paid",
    data: {
      object: {
        customer: "cus_recovery_paid_1",
        subscription: "sub_recovery_paid_new",
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_invoice_paid_recovery")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("recovery-paid.local");
    assert.equal(billing.plan, "starter");
    assert.equal(billing.billingStatus, "active");
    assert.equal(billing.stripeSubscriptionId, "sub_recovery_paid_new");
    assert.equal(billing.gracePeriodEndsAt, null);
  } finally {
    restore();
  }
});

test("invoice.payment_succeeded resolves open payment_failed alerts for the recovered site", async () => {
  resetStoreForTests();

  await upsertSiteBilling("recovery-alert.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_recovery_alert_1",
    stripeSubscriptionId: "sub_recovery_alert_1",
  });

  const { app, restore } = createAppWithMockedStripe(({ rawBody }) => JSON.parse(rawBody.toString("utf8")));

  try {
    const failedEvent = {
      id: "evt_recovery_alert_failed_1",
      type: "invoice.payment_failed",
      data: {
        object: {
          customer: "cus_recovery_alert_1",
          subscription: "sub_recovery_alert_1",
        },
      },
    };

    const failedRes = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_recovery_alert_failed")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(failedEvent));

    assert.equal(failedRes.status, 200);
    assert.equal(failedRes.body.received, true);

    const openAfterFailure = (await listOpenBillingAlerts(20)).filter((a) => a.site === "recovery-alert.local");
    assert.equal(openAfterFailure.length, 1);
    assert.equal(openAfterFailure[0].type, "payment_failed");

    const successEvent = {
      id: "evt_recovery_alert_success_1",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          customer: "cus_recovery_alert_1",
          subscription: "sub_recovery_alert_1",
        },
      },
    };

    const successRes = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_recovery_alert_success")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(successEvent));

    assert.equal(successRes.status, 200);
    assert.equal(successRes.body.received, true);

    const openAfterRecovery = (await listOpenBillingAlerts(20)).filter((a) => a.site === "recovery-alert.local");
    assert.equal(openAfterRecovery.length, 0);
  } finally {
    restore();
  }
});

test("invoice.paid with unknown customer is a safe no-op and still idempotent", async () => {
  resetStoreForTests();

  await upsertSiteBilling("paid-stable.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_paid_stable",
    stripeSubscriptionId: "sub_paid_stable",
  });

  const payload = {
    id: "evt_invoice_paid_unknown_1",
    type: "invoice.paid",
    data: {
      object: {
        customer: "cus_paid_unknown",
        subscription: "sub_paid_unknown",
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_invoice_paid_unknown")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    assert.equal(first.body.duplicate, undefined);

    const stable = await getSiteBilling("paid-stable.local");
    assert.equal(stable.plan, "starter");
    assert.equal(stable.billingStatus, "active");
    assert.equal(stable.stripeSubscriptionId, "sub_paid_stable");

    const processed = await hasProcessedBillingWebhookEvent("stripe", payload.id);
    assert.equal(processed, true);

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_invoice_paid_unknown")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);
  } finally {
    restore();
  }
});

test("invoice.payment_succeeded does not reactivate canceled subscriptions", async () => {
  resetStoreForTests();

  await upsertSiteBilling("canceled-recovery.local", {
    plan: "free",
    billingStatus: "canceled",
    stripeCustomerId: "cus_canceled_1",
    stripeSubscriptionId: "sub_canceled_1",
    gracePeriodEndsAt: null,
  });

  const payload = {
    id: "evt_payment_succeeded_canceled_1",
    type: "invoice.payment_succeeded",
    data: {
      object: {
        customer: "cus_canceled_1",
        subscription: "sub_canceled_new",
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_payment_succeeded_canceled")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);

    const billing = await getSiteBilling("canceled-recovery.local");
    assert.equal(billing.plan, "free");
    assert.equal(billing.billingStatus, "canceled");
    assert.equal(billing.stripeSubscriptionId, "sub_canceled_1");

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_payment_succeeded_canceled")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);
  } finally {
    restore();
  }
});

test("customer.subscription.deleted downgrades plan to free and status to canceled", async () => {
  resetStoreForTests();

  await upsertSiteBilling("cancel.local", {
    plan: "pro",
    billingStatus: "active",
    stripeCustomerId: "cus_cancel_1",
    stripeSubscriptionId: "sub_cancel_1",
  });

  const payload = {
    id: "evt_sub_deleted_1",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_cancel_1",
        customer: "cus_cancel_1",
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_test_2")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("cancel.local");
    assert.equal(billing.plan, "free");
    assert.equal(billing.billingStatus, "canceled");
  } finally {
    restore();
  }
});

test("checkout.session.completed with free plan is a safe no-op and still idempotent", async () => {
  resetStoreForTests();

  await upsertSiteBilling("checkout-stable.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_checkout_stable",
    stripeSubscriptionId: "sub_checkout_stable",
  });

  const payload = {
    id: "evt_checkout_completed_free_1",
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_checkout_new",
        subscription: "sub_checkout_new",
        metadata: {
          site: "checkout-new.local",
          plan: "free",
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_checkout_free")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    assert.equal(first.body.duplicate, undefined);

    const processed = await hasProcessedBillingWebhookEvent("stripe", payload.id);
    assert.equal(processed, true);

    const created = await getSiteBilling("checkout-new.local");
    assert.equal(created.plan, "free");
    assert.equal(created.billingStatus, "inactive");

    const stable = await getSiteBilling("checkout-stable.local");
    assert.equal(stable.plan, "starter");
    assert.equal(stable.billingStatus, "active");

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_checkout_free")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);
  } finally {
    restore();
  }
});

test("checkout.session.completed with missing site is a safe no-op and still idempotent", async () => {
  resetStoreForTests();

  await upsertSiteBilling("checkout-existing.local", {
    plan: "pro",
    billingStatus: "active",
    stripeCustomerId: "cus_checkout_existing",
    stripeSubscriptionId: "sub_checkout_existing",
  });

  const payload = {
    id: "evt_checkout_completed_missing_site_1",
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_missing_site",
        subscription: "sub_missing_site",
        metadata: {
          plan: "pro",
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_checkout_missing_site")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    assert.equal(first.body.duplicate, undefined);

    const processed = await hasProcessedBillingWebhookEvent("stripe", payload.id);
    assert.equal(processed, true);

    const existing = await getSiteBilling("checkout-existing.local");
    assert.equal(existing.plan, "pro");
    assert.equal(existing.billingStatus, "active");

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_checkout_missing_site")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);
  } finally {
    restore();
  }
});

test("customer.subscription.created stores active plan from metadata", async () => {
  resetStoreForTests();

  const payload = {
    id: "evt_sub_created_1",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_created_1",
        customer: "cus_created_1",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: {
          site: "created.local",
          plan: "pro",
        },
        items: {
          data: [
            {
              price: {
                nickname: "Starter monthly",
                metadata: {
                  site: "created.local",
                },
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_test_created")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("created.local");
    assert.equal(billing.plan, "pro");
    assert.equal(billing.billingStatus, "active");
    assert.equal(billing.stripeCustomerId, "cus_created_1");
    assert.equal(billing.stripeSubscriptionId, "sub_created_1");
    assert.ok(billing.currentPeriodEnd);
  } finally {
    restore();
  }
});

test("customer.subscription.created in past_due sets grace period and resolves plan from nickname", async () => {
  resetStoreForTests();

  const payload = {
    id: "evt_sub_created_past_due_1",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_created_past_due_1",
        customer: "cus_created_past_due_1",
        status: "past_due",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: {
          site: "created-past-due.local",
        },
        items: {
          data: [
            {
              price: {
                nickname: "Starter monthly",
                metadata: {
                  site: "created-past-due.local",
                },
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_test_created_past_due")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("created-past-due.local");
    assert.equal(billing.plan, "starter");
    assert.equal(billing.billingStatus, "past_due");
    assert.ok(billing.gracePeriodEndsAt);
    assert.ok(billing.currentPeriodEnd);
  } finally {
    restore();
  }
});

test("customer.subscription.updated resolves plan from price nickname when metadata plan is missing", async () => {
  resetStoreForTests();

  await upsertSiteBilling("nickname.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_nickname_1",
    stripeSubscriptionId: "sub_nickname_1",
  });

  const payload = {
    id: "evt_sub_updated_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_nickname_1",
        customer: "cus_nickname_1",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: {
          site: "nickname.local",
        },
        items: {
          data: [
            {
              price: {
                nickname: "Pro annual",
                metadata: {
                  site: "nickname.local",
                },
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_test_updated")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("nickname.local");
    assert.equal(billing.plan, "pro");
    assert.equal(billing.billingStatus, "active");
  } finally {
    restore();
  }
});

test("billing webhook returns 400 when stripe signature is missing", async () => {
  resetStoreForTests();

  const payload = {
    id: "evt_signature_missing_1",
    type: "invoice.payment_failed",
    data: { object: {} },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Webhook invalido");
  } finally {
    restore();
  }
});

test("billing webhook returns 400 when signature verification fails", async () => {
  resetStoreForTests();

  const { app, restore } = createAppWithMockedStripe(() => {
    throw new Error("signature mismatch");
  });

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_invalid")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ id: "evt_invalid_sig" }));

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Firma de webhook invalida/);
  } finally {
    restore();
  }
});

test("customer.subscription.updated resolves site by subscription id when metadata site is missing", async () => {
  resetStoreForTests();

  await upsertSiteBilling("sub-lookup.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_sub_lookup",
    stripeSubscriptionId: "sub_lookup_1",
  });

  const payload = {
    id: "evt_sub_lookup_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_lookup_1",
        customer: "cus_sub_lookup",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: {},
        items: {
          data: [
            {
              price: {
                nickname: "Starter monthly",
                metadata: {},
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_sub_lookup")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("sub-lookup.local");
    assert.equal(billing.plan, "starter");
    assert.equal(billing.billingStatus, "active");
  } finally {
    restore();
  }
});

test("customer.subscription.updated resolves site by customer id when subscription id lookup misses", async () => {
  resetStoreForTests();

  await upsertSiteBilling("customer-lookup.local", {
    plan: "starter",
    billingStatus: "active",
    stripeCustomerId: "cus_customer_lookup",
    stripeSubscriptionId: "sub_existing_other",
  });

  const payload = {
    id: "evt_customer_lookup_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_missing_lookup",
        customer: "cus_customer_lookup",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: {},
        items: {
          data: [
            {
              price: {
                nickname: "Pro annual",
                metadata: {},
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_customer_lookup")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("customer-lookup.local");
    assert.equal(billing.plan, "pro");
    assert.equal(billing.billingStatus, "active");
    assert.equal(billing.stripeSubscriptionId, "sub_missing_lookup");
  } finally {
    restore();
  }
});

test("customer.subscription.updated sets gracePeriodEndsAt on past_due and clears it on active", async () => {
  resetStoreForTests();

  await upsertSiteBilling("grace-transition.local", {
    plan: "pro",
    billingStatus: "active",
    stripeCustomerId: "cus_grace_1",
    stripeSubscriptionId: "sub_grace_1",
    gracePeriodEndsAt: null,
  });

  const pastDuePayload = {
    id: "evt_grace_transition_past_due",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_grace_1",
        customer: "cus_grace_1",
        status: "past_due",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: {
          site: "grace-transition.local",
          plan: "pro",
        },
        items: {
          data: [
            {
              price: {
                nickname: "Pro monthly",
                metadata: {
                  site: "grace-transition.local",
                },
              },
            },
          ],
        },
      },
    },
  };

  const recoveredPayload = {
    id: "evt_grace_transition_active",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_grace_1",
        customer: "cus_grace_1",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 172800,
        metadata: {
          site: "grace-transition.local",
          plan: "pro",
        },
        items: {
          data: [
            {
              price: {
                nickname: "Pro monthly",
                metadata: {
                  site: "grace-transition.local",
                },
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(({ rawBody }) => JSON.parse(rawBody.toString("utf8")));

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_grace_1")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(pastDuePayload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);

    const afterPastDue = await getSiteBilling("grace-transition.local");
    assert.equal(afterPastDue.billingStatus, "past_due");
    assert.ok(afterPastDue.gracePeriodEndsAt);

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_grace_2")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(recoveredPayload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);

    const afterRecovery = await getSiteBilling("grace-transition.local");
    assert.equal(afterRecovery.billingStatus, "active");
    assert.equal(afterRecovery.gracePeriodEndsAt, null);
  } finally {
    restore();
  }
});

test("customer.subscription.updated with no resolvable site is a safe no-op and still idempotent", async () => {
  resetStoreForTests();

  await upsertSiteBilling("stable.local", {
    plan: "pro",
    billingStatus: "active",
    stripeCustomerId: "cus_stable_1",
    stripeSubscriptionId: "sub_stable_1",
  });

  const payload = {
    id: "evt_sub_updated_unknown_site_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_unknown_site",
        customer: "cus_unknown_site",
        status: "past_due",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: {},
        items: {
          data: [
            {
              price: {
                nickname: "Pro annual",
                metadata: {},
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_unknown_site")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    assert.equal(first.body.duplicate, undefined);

    const processed = await hasProcessedBillingWebhookEvent("stripe", payload.id);
    assert.equal(processed, true);

    const stable = await getSiteBilling("stable.local");
    assert.equal(stable.billingStatus, "active");
    assert.equal(stable.plan, "pro");

    const second = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_unknown_site")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(second.status, 200);
    assert.equal(second.body.received, true);
    assert.equal(second.body.duplicate, true);
  } finally {
    restore();
  }
});

test("customer.subscription.deleted resolves site by customer id when subscription id lookup misses", async () => {
  resetStoreForTests();

  await upsertSiteBilling("delete-fallback.local", {
    plan: "pro",
    billingStatus: "active",
    stripeCustomerId: "cus_delete_fallback",
    stripeSubscriptionId: "sub_other_existing",
  });

  const payload = {
    id: "evt_sub_deleted_customer_fallback_1",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_not_found_for_delete",
        customer: "cus_delete_fallback",
        metadata: {},
        items: {
          data: [
            {
              price: {
                metadata: {},
              },
            },
          ],
        },
      },
    },
  };

  const { app, restore } = createAppWithMockedStripe(() => payload);

  try {
    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "sig_deleted_customer_fallback")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);

    const billing = await getSiteBilling("delete-fallback.local");
    assert.equal(billing.plan, "free");
    assert.equal(billing.billingStatus, "canceled");
    assert.equal(billing.stripeSubscriptionId, "sub_not_found_for_delete");
  } finally {
    restore();
  }
});
