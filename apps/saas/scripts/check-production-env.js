#!/usr/bin/env node

const required = [
  "DATABASE_URL",
  "APP_BASE_URL",
  "SESSION_SECRET",
  "SECURE_COOKIES",
  "ALLOW_LEGACY_API_KEYS",
  "REQUIRE_SHOP_ONBOARDING",
  "ONBOARDING_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_PRO",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "SUPPORT_EMAIL",
  "METRICS_BEARER_TOKEN",
];

const expected = {
  NODE_ENV: "production",
  SECURE_COOKIES: "true",
  ALLOW_LEGACY_API_KEYS: "false",
  REQUIRE_SHOP_ONBOARDING: "true",
  ALLOW_ONBOARDING_EMAIL_DOMAIN_BYPASS: "false",
};

let hasError = false;

for (const key of required) {
  if (!String(process.env[key] || "").trim()) {
    console.error(`Missing required env var: ${key}`);
    hasError = true;
  }
}

for (const [key, value] of Object.entries(expected)) {
  const current = String(process.env[key] || "").trim();
  if (!current) {
    console.error(`Missing recommended strict env var: ${key}=${value}`);
    hasError = true;
    continue;
  }

  if (current !== value) {
    console.error(`Invalid value for ${key}. Expected '${value}', got '${current}'`);
    hasError = true;
  }
}

if (hasError) {
  console.error("Production env check failed.");
  process.exit(1);
}

console.log("Production env check passed.");
