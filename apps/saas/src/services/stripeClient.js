const Stripe = require("stripe");
const {
  stripeSecretKey,
  stripeWebhookSecret,
  stripePriceStarter,
  stripePricePro,
} = require("../config/env");

let stripeInstance = null;

function getStripeClient() {
  if (!stripeSecretKey) {
    return null;
  }

  if (!stripeInstance) {
    stripeInstance = new Stripe(stripeSecretKey);
  }

  return stripeInstance;
}

function getPriceIdForPlan(plan) {
  if (plan === "starter") {
    return stripePriceStarter;
  }
  if (plan === "pro") {
    return stripePricePro;
  }
  return "";
}

function hasStripeBillingConfig() {
  return Boolean(stripeSecretKey && stripeWebhookSecret && stripePriceStarter && stripePricePro);
}

module.exports = {
  getStripeClient,
  getPriceIdForPlan,
  hasStripeBillingConfig,
  stripeWebhookSecret,
};
