const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { createApp } = require("../src/app");
const env = require("../src/config/env");
const { upsertDashboardAccessPolicy, resetStoreForTests } = require("../src/data/store");

function createHs256Jwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  return `${headerB64}.${payloadB64}.${signature}`;
}

function createRs256Jwt(payload, privateKey, kid = "test-kid") {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey)
    .toString("base64url");

  return `${headerB64}.${payloadB64}.${signature}`;
}

function createJsonResponse(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return jsonBody;
    },
  };
}

test("GET /dashboard without session redirects to login", async () => {
  const app = createApp();
  const res = await request(app).get("/dashboard");

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/auth/login");
});

test("GET /auth/verify with invalid token returns 401", async () => {
  const app = createApp();
  const res = await request(app).get("/auth/verify?token=invalid-token");

  assert.equal(res.status, 401);
});

test("GET /auth/oidc/start returns 404 when OIDC is disabled", async () => {
  const app = createApp();
  const originalOidcEnabled = env.dashboardOidcEnabled;
  env.dashboardOidcEnabled = false;

  try {
    const res = await request(app).get("/auth/oidc/start");
    assert.equal(res.status, 404);
  } finally {
    env.dashboardOidcEnabled = originalOidcEnabled;
  }
});

test("auth magic link verification sets session cookie", async () => {
  const app = createApp();

  const login = await request(app).get("/auth/login");
  const csrfMatch = login.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should exist in login form");

  const csrf = csrfMatch[1];
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie, "CSRF cookie should be set");

  const requestLink = await request(app)
    .post("/auth/request-link")
    .set("Cookie", cookie)
    .type("form")
    .send({ email: "admin@consenthub.local", _csrf: csrf });

  assert.equal(requestLink.status, 200);

  const tokenMatch = requestLink.text.match(/\/auth\/verify\?token=([a-f0-9]+)/);
  assert.ok(tokenMatch, "Magic link token should be present in dev mode response");

  const token = tokenMatch[1];
  const verify = await request(app).get(`/auth/verify?token=${token}`);

  assert.equal(verify.status, 302);
  assert.equal(verify.headers.location, "/dashboard-v2");
  const setCookie = verify.headers["set-cookie"] || [];
  assert.ok(
    setCookie.some((line) => line.includes("consenthub_session=")),
    "Session cookie should be set on verify"
  );
});

test("GET /auth/sso logs in with trusted headers when enabled", async () => {
  const app = createApp();
  const originalEnabled = env.dashboardSsoEnabled;
  const originalSecret = env.dashboardSsoHeaderSecret;

  env.dashboardSsoEnabled = true;
  env.dashboardSsoHeaderSecret = "sso-test-secret";

  try {
    const res = await request(app)
      .get("/auth/sso")
      .set("x-sso-secret", "sso-test-secret")
      .set("x-sso-email", "admin@consenthub.local");

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/dashboard-v2");
    const setCookie = res.headers["set-cookie"] || [];
    assert.ok(
      setCookie.some((line) => line.includes("consenthub_session=")),
      "Session cookie should be set on SSO login"
    );
  } finally {
    env.dashboardSsoEnabled = originalEnabled;
    env.dashboardSsoHeaderSecret = originalSecret;
  }
});

test("GET /auth/sso rejects misconfigured bridge without secret material", async () => {
  const app = createApp();
  const originalEnabled = env.dashboardSsoEnabled;
  const originalHeaderSecret = env.dashboardSsoHeaderSecret;
  const originalJwtSecret = env.dashboardSsoJwtSecret;

  env.dashboardSsoEnabled = true;
  env.dashboardSsoHeaderSecret = "";
  env.dashboardSsoJwtSecret = "";

  try {
    const res = await request(app)
      .get("/auth/sso")
      .set("x-sso-email", "admin@consenthub.local");

    assert.equal(res.status, 503);
    assert.match(res.text, /Bridge SSO mal configurado/i);
  } finally {
    env.dashboardSsoEnabled = originalEnabled;
    env.dashboardSsoHeaderSecret = originalHeaderSecret;
    env.dashboardSsoJwtSecret = originalJwtSecret;
  }
});

test("GET /auth/sso accepts valid JWT header and downscopes claims", async () => {
  resetStoreForTests();
  await upsertDashboardAccessPolicy({
    email: "admin@consenthub.local",
    role: "admin",
    sites: ["*"],
    status: "active",
  });

  const app = createApp();
  const originalEnabled = env.dashboardSsoEnabled;
  const originalHeaderSecret = env.dashboardSsoHeaderSecret;
  const originalJwtSecret = env.dashboardSsoJwtSecret;

  env.dashboardSsoEnabled = true;
  env.dashboardSsoHeaderSecret = "";
  env.dashboardSsoJwtSecret = "jwt-test-secret";

  try {
    const token = createHs256Jwt(
      {
        email: "admin@consenthub.local",
        role: "analyst",
        sites: ["tenant-a.local"],
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      env.dashboardSsoJwtSecret
    );

    const res = await request(app)
      .get("/auth/sso")
      .set("x-sso-jwt", token);

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/dashboard-v2");
    const setCookie = res.headers["set-cookie"] || [];
    const sessionCookieLine = setCookie.find((line) => line.includes("consenthub_session="));
    assert.ok(sessionCookieLine, "Session cookie should be set on JWT SSO login");

    const cookieValue = sessionCookieLine.split(";")[0].split("=")[1];
    const decoded = Buffer.from(cookieValue, "base64url").toString("utf8");
    const [jsonPart] = decoded.split(".");
    const payload = JSON.parse(jsonPart);
    assert.equal(payload.role, "analyst");
    assert.deepEqual(payload.sites, ["tenant-a.local"]);
  } finally {
    env.dashboardSsoEnabled = originalEnabled;
    env.dashboardSsoHeaderSecret = originalHeaderSecret;
    env.dashboardSsoJwtSecret = originalJwtSecret;
  }
});

test("GET /auth/sso rejects invalid JWT signature", async () => {
  const app = createApp();
  const originalEnabled = env.dashboardSsoEnabled;
  const originalHeaderSecret = env.dashboardSsoHeaderSecret;
  const originalJwtSecret = env.dashboardSsoJwtSecret;

  env.dashboardSsoEnabled = true;
  env.dashboardSsoHeaderSecret = "";
  env.dashboardSsoJwtSecret = "jwt-test-secret";

  try {
    const token = createHs256Jwt(
      {
        email: "admin@consenthub.local",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      "different-secret"
    );

    const res = await request(app)
      .get("/auth/sso")
      .set("x-sso-jwt", token);

    assert.equal(res.status, 401);
    assert.match(res.text, /JWT SSO invalido/i);
  } finally {
    env.dashboardSsoEnabled = originalEnabled;
    env.dashboardSsoHeaderSecret = originalHeaderSecret;
    env.dashboardSsoJwtSecret = originalJwtSecret;
  }
});

test("GET /auth/sso rejects expired JWT", async () => {
  const app = createApp();
  const originalEnabled = env.dashboardSsoEnabled;
  const originalHeaderSecret = env.dashboardSsoHeaderSecret;
  const originalJwtSecret = env.dashboardSsoJwtSecret;

  env.dashboardSsoEnabled = true;
  env.dashboardSsoHeaderSecret = "";
  env.dashboardSsoJwtSecret = "jwt-test-secret";

  try {
    const token = createHs256Jwt(
      {
        email: "admin@consenthub.local",
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      env.dashboardSsoJwtSecret
    );

    const res = await request(app)
      .get("/auth/sso")
      .set("x-sso-jwt", token);

    assert.equal(res.status, 401);
    assert.match(res.text, /JWT SSO invalido/i);
  } finally {
    env.dashboardSsoEnabled = originalEnabled;
    env.dashboardSsoHeaderSecret = originalHeaderSecret;
    env.dashboardSsoJwtSecret = originalJwtSecret;
  }
});

test("GET /auth/oidc/start redirects to provider authorization endpoint", async () => {
  const app = createApp();
  const originalFetch = global.fetch;
  const originalOidcEnabled = env.dashboardOidcEnabled;
  const originalIssuer = env.dashboardOidcIssuer;
  const originalClientId = env.dashboardOidcClientId;
  const originalClientSecret = env.dashboardOidcClientSecret;

  env.dashboardOidcEnabled = true;
  env.dashboardOidcIssuer = "https://idp.example.com";
  env.dashboardOidcClientId = "client-123";
  env.dashboardOidcClientSecret = "secret-123";

  global.fetch = async (url) => {
    assert.match(String(url), /\.well-known\/openid-configuration/);
    return createJsonResponse(200, {
      authorization_endpoint: "https://idp.example.com/oauth2/v1/authorize",
      token_endpoint: "https://idp.example.com/oauth2/v1/token",
      jwks_uri: "https://idp.example.com/oauth2/v1/keys",
    });
  };

  try {
    const res = await request(app).get("/auth/oidc/start");
    assert.equal(res.status, 302);
    assert.match(String(res.headers.location), /^https:\/\/idp\.example\.com\/oauth2\/v1\/authorize\?/);
    assert.match(String(res.headers.location), /client_id=client-123/);
    assert.match(String(res.headers.location), /response_type=code/);

    const setCookie = res.headers["set-cookie"] || [];
    assert.ok(
      setCookie.some((line) => line.includes("consenthub_oidc_state=")),
      "OIDC state cookie should be set"
    );
  } finally {
    global.fetch = originalFetch;
    env.dashboardOidcEnabled = originalOidcEnabled;
    env.dashboardOidcIssuer = originalIssuer;
    env.dashboardOidcClientId = originalClientId;
    env.dashboardOidcClientSecret = originalClientSecret;
  }
});

test("GET /auth/oidc/callback creates session for valid enterprise OIDC login", async () => {
  const app = createApp();
  const originalFetch = global.fetch;
  const originalOidcEnabled = env.dashboardOidcEnabled;
  const originalIssuer = env.dashboardOidcIssuer;
  const originalClientId = env.dashboardOidcClientId;
  const originalClientSecret = env.dashboardOidcClientSecret;

  env.dashboardOidcEnabled = true;
  env.dashboardOidcIssuer = "https://idp.example.com";
  env.dashboardOidcClientId = "client-123";
  env.dashboardOidcClientSecret = "secret-123";

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = "oidc-test-kid";
  const calls = [];
  let nonceForToken = "";

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: String(options.method || "GET") });

    if (String(url).includes(".well-known/openid-configuration")) {
      return createJsonResponse(200, {
        authorization_endpoint: "https://idp.example.com/oauth2/v1/authorize",
        token_endpoint: "https://idp.example.com/oauth2/v1/token",
        jwks_uri: "https://idp.example.com/oauth2/v1/keys",
      });
    }

    if (String(url).includes("/oauth2/v1/token")) {
      const body = String(options.body || "");
      const params = new URLSearchParams(body);
      const idToken = createRs256Jwt(
        {
          iss: "https://idp.example.com",
          aud: "client-123",
          email: "admin@consenthub.local",
          nonce: nonceForToken,
          exp: Math.floor(Date.now() / 1000) + 300,
        },
        privateKey,
        kid
      );

      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), "code-123");

      return createJsonResponse(200, { id_token: idToken });
    }

    if (String(url).includes("/oauth2/v1/keys")) {
      return createJsonResponse(200, {
        keys: [{ ...jwk, kid, use: "sig", kty: "RSA", alg: "RS256" }],
      });
    }

    return createJsonResponse(404, {});
  };

  try {
    const start = await request(app).get("/auth/oidc/start");
    assert.equal(start.status, 302);
    const location = new URL(start.headers.location);
    const state = location.searchParams.get("state");
    const nonce = location.searchParams.get("nonce");
    assert.ok(state);
    assert.ok(nonce);
    nonceForToken = nonce;

    const stateCookie = (start.headers["set-cookie"] || []).find((line) => line.includes("consenthub_oidc_state="));
    assert.ok(stateCookie, "OIDC state cookie is required for callback");

    const callback = await request(app)
      .get(`/auth/oidc/callback?code=code-123&state=${encodeURIComponent(state)}`)
      .set("Cookie", stateCookie);

    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, "/dashboard-v2");
    const callbackCookies = callback.headers["set-cookie"] || [];
    assert.ok(
      callbackCookies.some((line) => line.includes("consenthub_session=")),
      "Session cookie should be set after valid OIDC callback"
    );
    assert.ok(calls.some((entry) => entry.url.includes("/oauth2/v1/token")));
    assert.ok(calls.some((entry) => entry.url.includes("/oauth2/v1/keys")));
  } finally {
    global.fetch = originalFetch;
    env.dashboardOidcEnabled = originalOidcEnabled;
    env.dashboardOidcIssuer = originalIssuer;
    env.dashboardOidcClientId = originalClientId;
    env.dashboardOidcClientSecret = originalClientSecret;
  }
});

test("GET /auth/oidc/callback rejects invalid state", async () => {
  const app = createApp();
  const originalFetch = global.fetch;
  const originalOidcEnabled = env.dashboardOidcEnabled;
  const originalIssuer = env.dashboardOidcIssuer;
  const originalClientId = env.dashboardOidcClientId;
  const originalClientSecret = env.dashboardOidcClientSecret;

  env.dashboardOidcEnabled = true;
  env.dashboardOidcIssuer = "https://idp.example.com";
  env.dashboardOidcClientId = "client-123";
  env.dashboardOidcClientSecret = "secret-123";

  global.fetch = async (url) => {
    if (String(url).includes(".well-known/openid-configuration")) {
      return createJsonResponse(200, {
        authorization_endpoint: "https://idp.example.com/oauth2/v1/authorize",
        token_endpoint: "https://idp.example.com/oauth2/v1/token",
        jwks_uri: "https://idp.example.com/oauth2/v1/keys",
      });
    }
    return createJsonResponse(500, {});
  };

  try {
    const start = await request(app).get("/auth/oidc/start");
    const stateCookie = (start.headers["set-cookie"] || []).find((line) => line.includes("consenthub_oidc_state="));
    assert.ok(stateCookie);

    const callback = await request(app)
      .get("/auth/oidc/callback?code=code-123&state=bad-state")
      .set("Cookie", stateCookie);

    assert.equal(callback.status, 401);
    assert.match(callback.text, /OIDC state invalido/i);
    const cookies = callback.headers["set-cookie"] || [];
    assert.ok(
      cookies.some((line) => line.includes("consenthub_oidc_state=") && line.includes("Max-Age=0")),
      "OIDC state cookie should be cleared on invalid state"
    );
  } finally {
    global.fetch = originalFetch;
    env.dashboardOidcEnabled = originalOidcEnabled;
    env.dashboardOidcIssuer = originalIssuer;
    env.dashboardOidcClientId = originalClientId;
    env.dashboardOidcClientSecret = originalClientSecret;
  }
});

test("GET /auth/oidc/callback clears state cookie when id_token is invalid", async () => {
  const app = createApp();
  const originalFetch = global.fetch;
  const originalOidcEnabled = env.dashboardOidcEnabled;
  const originalIssuer = env.dashboardOidcIssuer;
  const originalClientId = env.dashboardOidcClientId;
  const originalClientSecret = env.dashboardOidcClientSecret;

  env.dashboardOidcEnabled = true;
  env.dashboardOidcIssuer = "https://idp.example.com";
  env.dashboardOidcClientId = "client-123";
  env.dashboardOidcClientSecret = "secret-123";

  global.fetch = async (url) => {
    if (String(url).includes(".well-known/openid-configuration")) {
      return createJsonResponse(200, {
        authorization_endpoint: "https://idp.example.com/oauth2/v1/authorize",
        token_endpoint: "https://idp.example.com/oauth2/v1/token",
        jwks_uri: "https://idp.example.com/oauth2/v1/keys",
      });
    }
    if (String(url).includes("/oauth2/v1/token")) {
      return createJsonResponse(200, { id_token: "not-a-valid-jwt" });
    }
    if (String(url).includes("/oauth2/v1/keys")) {
      return createJsonResponse(200, { keys: [] });
    }
    return createJsonResponse(404, {});
  };

  try {
    const start = await request(app).get("/auth/oidc/start");
    const location = new URL(start.headers.location);
    const state = location.searchParams.get("state");
    const stateCookie = (start.headers["set-cookie"] || []).find((line) => line.includes("consenthub_oidc_state="));
    assert.ok(stateCookie);

    const callback = await request(app)
      .get(`/auth/oidc/callback?code=code-123&state=${encodeURIComponent(state)}`)
      .set("Cookie", stateCookie);

    assert.equal(callback.status, 401);
    assert.match(callback.text, /OIDC id_token invalido/i);
    const cookies = callback.headers["set-cookie"] || [];
    assert.ok(
      cookies.some((line) => line.includes("consenthub_oidc_state=") && line.includes("Max-Age=0")),
      "OIDC state cookie should be cleared on invalid id_token"
    );
  } finally {
    global.fetch = originalFetch;
    env.dashboardOidcEnabled = originalOidcEnabled;
    env.dashboardOidcIssuer = originalIssuer;
    env.dashboardOidcClientId = originalClientId;
    env.dashboardOidcClientSecret = originalClientSecret;
  }
});

test("auth magic link accepts enterprise policy email not listed in ADMIN_EMAILS", async () => {
  resetStoreForTests();
  await upsertDashboardAccessPolicy({
    email: "operator@enterprise.local",
    role: "operator",
    sites: ["tenant-a.local"],
    status: "active",
  });

  const app = createApp();

  const login = await request(app).get("/auth/login");
  const csrfMatch = login.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch, "CSRF token should exist in login form");

  const csrf = csrfMatch[1];
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie, "CSRF cookie should be set");

  const requestLink = await request(app)
    .post("/auth/request-link")
    .set("Cookie", cookie)
    .type("form")
    .send({ email: "operator@enterprise.local", _csrf: csrf });

  assert.equal(requestLink.status, 200);
  const tokenMatch = requestLink.text.match(/\/auth\/verify\?token=([a-f0-9]+)/);
  assert.ok(tokenMatch, "Magic link token should be present in dev mode response");

  const verify = await request(app).get(`/auth/verify?token=${tokenMatch[1]}`);
  assert.equal(verify.status, 302);
  assert.equal(verify.headers.location, "/dashboard-v2");
});
