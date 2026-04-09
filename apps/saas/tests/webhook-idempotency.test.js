const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resetStoreForTests,
  hasProcessedBillingWebhookEvent,
  markBillingWebhookEventProcessed,
} = require("../src/data/store");

test("billing webhook idempotency helpers track processed event ids", async () => {
  resetStoreForTests();

  const provider = "stripe";
  const eventId = "evt_test_123";

  const before = await hasProcessedBillingWebhookEvent(provider, eventId);
  assert.equal(before, false);

  const marked = await markBillingWebhookEventProcessed(provider, eventId);
  assert.equal(marked, true);

  const after = await hasProcessedBillingWebhookEvent(provider, eventId);
  assert.equal(after, true);
});
