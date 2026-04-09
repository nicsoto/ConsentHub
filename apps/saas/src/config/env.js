const dotenv = require("dotenv");

dotenv.config();

const apiKeys = (process.env.API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const scopedApiKeys = (process.env.API_SITE_KEYS || "")
  .split(";")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [key, site, scopesRaw] = entry.split("|").map((part) => part.trim());
    if (!key || !site || !scopesRaw) {
      return null;
    }

    const scopes = scopesRaw
      .split(",")
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean);

    if (scopes.length === 0) {
      return null;
    }

    return {
      key,
      site: site.toLowerCase(),
      scopes,
    };
  })
  .filter(Boolean);

const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedAdminEmails = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const dashboardAccessPolicies = (process.env.DASHBOARD_ACCESS_POLICIES || "")
  .split(";")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [emailRaw, roleRaw, sitesRaw] = entry.split("|").map((part) => String(part || "").trim());
    const email = emailRaw.toLowerCase();
    const role = roleRaw.toLowerCase() || "admin";
    const sites = sitesRaw
      .split(",")
      .map((site) => site.trim().toLowerCase())
      .filter(Boolean);

    if (!email) {
      return null;
    }

    return {
      email,
      role,
      sites: sites.length > 0 ? sites : ["*"],
    };
  })
  .filter(Boolean);

const metricsAllowedIps = (process.env.METRICS_ALLOWED_IPS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const runtimeNodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase();
const defaultAuditRateLimitWindowMs = 60_000;
const defaultAuditRateLimitMax = runtimeNodeEnv === "production" ? 10 : 60;
const defaultAllowLegacyApiKeys = runtimeNodeEnv === "production" ? "false" : "true";
const defaultCountryCode = String(process.env.DEFAULT_COUNTRY_CODE || "CL").trim().toUpperCase();

function validateConfig() {
  const errors = [];
  const isProd = process.env.NODE_ENV === "production";
  const appRole = String(process.env.APP_ROLE || "web").trim().toLowerCase();

  if (apiKeys.length === 0 && scopedApiKeys.length === 0) {
    errors.push("Configure at least one API auth mechanism: API_KEYS or API_SITE_KEYS");
  }

  if (allowedAdminEmails.length === 0) {
    errors.push("ADMIN_EMAILS must contain at least one admin email");
  }

  if (!/^[A-Z]{2}$/.test(defaultCountryCode)) {
    errors.push("DEFAULT_COUNTRY_CODE must be a 2-letter uppercase country code");
  }

  const ssoEnabled = String(process.env.DASHBOARD_SSO_ENABLED || "false") === "true";
  const ssoHeaderSecret = String(process.env.DASHBOARD_SSO_HEADER_SECRET || "").trim();
  const ssoJwtSecret = String(process.env.DASHBOARD_SSO_JWT_SECRET || "").trim();
  if (ssoEnabled && !ssoHeaderSecret && !ssoJwtSecret) {
    errors.push("DASHBOARD_SSO_ENABLED=true requires DASHBOARD_SSO_HEADER_SECRET or DASHBOARD_SSO_JWT_SECRET");
  }

  const oidcEnabled = String(process.env.DASHBOARD_OIDC_ENABLED || "false") === "true";
  if (oidcEnabled) {
    if (!String(process.env.DASHBOARD_OIDC_ISSUER || "").trim()) {
      errors.push("DASHBOARD_OIDC_ISSUER must be configured when DASHBOARD_OIDC_ENABLED=true");
    }
    if (!String(process.env.DASHBOARD_OIDC_CLIENT_ID || "").trim()) {
      errors.push("DASHBOARD_OIDC_CLIENT_ID must be configured when DASHBOARD_OIDC_ENABLED=true");
    }
    if (!String(process.env.DASHBOARD_OIDC_CLIENT_SECRET || "").trim()) {
      errors.push("DASHBOARD_OIDC_CLIENT_SECRET must be configured when DASHBOARD_OIDC_ENABLED=true");
    }
  }

  if (isProd) {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "dev-insecure-change-me") {
      errors.push("SESSION_SECRET must be configured with a strong value in production");
    }

    if (String(process.env.SECURE_COOKIES || "false") !== "true") {
      errors.push("SECURE_COOKIES must be true in production");
    }

    const metricsEnabledInProd = String(process.env.METRICS_ENABLED || "true") === "true";
    const metricsToken = String(process.env.METRICS_BEARER_TOKEN || "").trim();
    if (metricsEnabledInProd && !metricsToken) {
      errors.push("METRICS_BEARER_TOKEN must be configured in production when METRICS_ENABLED=true");
    }

    const legacyAllowedInProd = String(process.env.ALLOW_LEGACY_API_KEYS || defaultAllowLegacyApiKeys) === "true";
    if (legacyAllowedInProd) {
      errors.push("ALLOW_LEGACY_API_KEYS must be false in production");
    }

  }

  if (!["web", "worker", "all"].includes(appRole)) {
    errors.push("APP_ROLE must be one of: web, worker, all");
  }

  return errors;
}

function resolveDashboardAccess(emailInput) {
  const email = String(emailInput || "").trim().toLowerCase();
  if (!email) {
    return null;
  }

  const policy = dashboardAccessPolicies.find((row) => row.email === email);
  if (policy) {
    return {
      email,
      role: policy.role || "admin",
      sites: Array.isArray(policy.sites) && policy.sites.length > 0 ? policy.sites : ["*"],
    };
  }

  if (allowedAdminEmails.includes(email)) {
    return {
      email,
      role: "admin",
      sites: ["*"],
    };
  }

  return null;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  appRole: String(process.env.APP_ROLE || "web").trim().toLowerCase(),
  port: Number(process.env.PORT || 8787),
  apiKeys,
  scopedApiKeys,
  corsAllowedOrigins,
  allowedAdminEmails,
  dashboardAccessPolicies,
  sessionSecret: process.env.SESSION_SECRET || "dev-insecure-change-me",
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${Number(process.env.PORT || 8787)}`,
  isSecureCookies: String(process.env.SECURE_COOKIES || "false") === "true",
  retentionJobMinutes: Number(process.env.RETENTION_JOB_MINUTES || 60),
  billingAlertJobMinutes: Number(process.env.BILLING_ALERT_JOB_MINUTES || 1440),
  billingCriticalEmailCooldownMinutes: Number(process.env.BILLING_CRITICAL_EMAIL_COOLDOWN_MINUTES || 180),
  defaultCountryCode,
  readinessCheckStripe: String(process.env.READINESS_CHECK_STRIPE || "false") === "true",
  readinessDbTimeoutMs: Math.max(100, Number(process.env.READINESS_DB_TIMEOUT_MS || 1500)),
  readinessStripeTimeoutMs: Math.max(100, Number(process.env.READINESS_STRIPE_TIMEOUT_MS || 1500)),
  auditLogsRateLimitWindowMs: Math.max(
    1000,
    Number(process.env.AUDIT_LOGS_RATE_LIMIT_WINDOW_MS || defaultAuditRateLimitWindowMs)
  ),
  auditLogsRateLimitMax: Math.max(1, Number(process.env.AUDIT_LOGS_RATE_LIMIT_MAX || defaultAuditRateLimitMax)),
  metricsEnabled: String(process.env.METRICS_ENABLED || "true") === "true",
  metricsBearerToken: String(process.env.METRICS_BEARER_TOKEN || "").trim(),
  metricsAllowedIps,
  allowLegacyApiKeys: String(process.env.ALLOW_LEGACY_API_KEYS || defaultAllowLegacyApiKeys) === "true",
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "",
  supportEmail: process.env.SUPPORT_EMAIL || "soporte@consenthub.local",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePriceStarter: process.env.STRIPE_PRICE_STARTER || "",
  stripePricePro: process.env.STRIPE_PRICE_PRO || "",
  billingGraceDays: Number(process.env.BILLING_GRACE_DAYS || 7),
  dashboardSsoEnabled: String(process.env.DASHBOARD_SSO_ENABLED || "false") === "true",
  dashboardSsoHeaderSecret: String(process.env.DASHBOARD_SSO_HEADER_SECRET || "").trim(),
  dashboardSsoHeaderEmail: String(process.env.DASHBOARD_SSO_HEADER_EMAIL || "x-sso-email").trim().toLowerCase(),
  dashboardSsoHeaderSites: String(process.env.DASHBOARD_SSO_HEADER_SITES || "x-sso-sites").trim().toLowerCase(),
  dashboardSsoHeaderJwt: String(process.env.DASHBOARD_SSO_HEADER_JWT || "x-sso-jwt").trim().toLowerCase(),
  dashboardSsoJwtSecret: String(process.env.DASHBOARD_SSO_JWT_SECRET || "").trim(),
  dashboardOidcEnabled: String(process.env.DASHBOARD_OIDC_ENABLED || "false") === "true",
  dashboardOidcIssuer: String(process.env.DASHBOARD_OIDC_ISSUER || "").trim(),
  dashboardOidcDiscoveryUrl: String(process.env.DASHBOARD_OIDC_DISCOVERY_URL || "").trim(),
  dashboardOidcClientId: String(process.env.DASHBOARD_OIDC_CLIENT_ID || "").trim(),
  dashboardOidcClientSecret: String(process.env.DASHBOARD_OIDC_CLIENT_SECRET || "").trim(),
  dashboardOidcRedirectUri: String(process.env.DASHBOARD_OIDC_REDIRECT_URI || "").trim(),
  dashboardOidcScopes: String(process.env.DASHBOARD_OIDC_SCOPES || "openid email profile").trim(),
  requireShopOnboarding: String(process.env.REQUIRE_SHOP_ONBOARDING || (runtimeNodeEnv === "production" ? "true" : "false")) === "true",
  onboardingSecret: String(process.env.ONBOARDING_SECRET || "").trim(),
  allowOnboardingEmailDomainBypass: String(process.env.ALLOW_ONBOARDING_EMAIL_DOMAIN_BYPASS || "false") === "true",
  resolveDashboardAccess,
  validateConfig,
};
