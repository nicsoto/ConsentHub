const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const envModulePath = path.resolve(__dirname, "../src/config/env.js");

function withEnv(overrides, fn) {
  const original = { ...process.env };

  Object.keys(process.env).forEach((key) => {
    delete process.env[key];
  });

  Object.assign(process.env, original, overrides);

  delete require.cache[envModulePath];

  try {
    fn();
  } finally {
    delete require.cache[envModulePath];
    Object.keys(process.env).forEach((key) => {
      delete process.env[key];
    });
    Object.assign(process.env, original);
  }
}

test("validateConfig requires METRICS_BEARER_TOKEN in production when metrics are enabled", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "true",
      METRICS_BEARER_TOKEN: "",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.ok(
        errors.includes("METRICS_BEARER_TOKEN must be configured in production when METRICS_ENABLED=true")
      );
    }
  );
});

test("validateConfig allows production metrics disabled without bearer token", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "false",
      METRICS_BEARER_TOKEN: "",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.equal(errors.length, 0);
    }
  );
});

test("validateConfig allows production metrics enabled with bearer token", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "true",
      METRICS_BEARER_TOKEN: "metrics-token-123",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.equal(errors.length, 0);
    }
  );
});

test("validateConfig rejects ALLOW_LEGACY_API_KEYS=true in production", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "false",
      ALLOW_LEGACY_API_KEYS: "true",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.ok(errors.includes("ALLOW_LEGACY_API_KEYS must be false in production"));
    }
  );
});

test("validateConfig allows ALLOW_LEGACY_API_KEYS=false in production", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "false",
      ALLOW_LEGACY_API_KEYS: "false",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.equal(errors.length, 0);
    }
  );
});

test("validateConfig requires OIDC issuer/client settings when OIDC is enabled", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "false",
      ALLOW_LEGACY_API_KEYS: "false",
      DASHBOARD_OIDC_ENABLED: "true",
      DASHBOARD_OIDC_ISSUER: "",
      DASHBOARD_OIDC_CLIENT_ID: "",
      DASHBOARD_OIDC_CLIENT_SECRET: "",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.ok(errors.includes("DASHBOARD_OIDC_ISSUER must be configured when DASHBOARD_OIDC_ENABLED=true"));
      assert.ok(errors.includes("DASHBOARD_OIDC_CLIENT_ID must be configured when DASHBOARD_OIDC_ENABLED=true"));
      assert.ok(errors.includes("DASHBOARD_OIDC_CLIENT_SECRET must be configured when DASHBOARD_OIDC_ENABLED=true"));
    }
  );
});

test("validateConfig accepts OIDC enabled when issuer and client settings are configured", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "false",
      ALLOW_LEGACY_API_KEYS: "false",
      DASHBOARD_OIDC_ENABLED: "true",
      DASHBOARD_OIDC_ISSUER: "https://idp.example.com",
      DASHBOARD_OIDC_CLIENT_ID: "client-123",
      DASHBOARD_OIDC_CLIENT_SECRET: "secret-123",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.equal(errors.length, 0);
    }
  );
});

test("validateConfig requires SSO secret material when bridge is enabled", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "false",
      ALLOW_LEGACY_API_KEYS: "false",
      DASHBOARD_SSO_ENABLED: "true",
      DASHBOARD_SSO_HEADER_SECRET: "",
      DASHBOARD_SSO_JWT_SECRET: "",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.ok(
        errors.includes("DASHBOARD_SSO_ENABLED=true requires DASHBOARD_SSO_HEADER_SECRET or DASHBOARD_SSO_JWT_SECRET")
      );
    }
  );
});

test("validateConfig accepts SSO enabled when JWT secret is configured", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ROLE: "web",
      API_KEYS: "prod-key",
      ADMIN_EMAILS: "admin@consenthub.local",
      SESSION_SECRET: "super-secret-prod-value",
      SECURE_COOKIES: "true",
      METRICS_ENABLED: "false",
      ALLOW_LEGACY_API_KEYS: "false",
      DASHBOARD_SSO_ENABLED: "true",
      DASHBOARD_SSO_HEADER_SECRET: "",
      DASHBOARD_SSO_JWT_SECRET: "jwt-secret-123",
    },
    () => {
      const env = require("../src/config/env");
      const errors = env.validateConfig();
      assert.equal(errors.length, 0);
    }
  );
});
