const env = require("../config/env");
const { findActiveApiCredentialByKey, touchApiCredentialLastUsed } = require("../data/store");

const FULL_SCOPES = ["ingest", "read", "export", "shops"];

function normalizeSite(value) {
  return String(value || "").trim().toLowerCase();
}

function hasScope(apiAuth, scope) {
  if (!apiAuth || !apiAuth.scopes) {
    return false;
  }

  return apiAuth.scopes.has("*") || apiAuth.scopes.has(scope);
}

function isSiteAuthorized(req, site) {
  const auth = req.apiAuth;
  if (!auth || !auth.site) {
    return true;
  }
  return auth.site === normalizeSite(site);
}

async function requireApiKey(req, res, next) {
  if (env.apiKeys.length === 0 && env.scopedApiKeys.length === 0) {
    const candidateOnly = req.header("x-api-key");
    if (!candidateOnly) {
      return res.status(500).json({ error: "Server API keys not configured" });
    }
  }

  const candidate = req.header("x-api-key");
  if (!candidate) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const dbCredential = await findActiveApiCredentialByKey(candidate);
    if (dbCredential) {
      req.apiAuth = {
        keyType: "db-scoped",
        site: normalizeSite(dbCredential.site),
        scopes: new Set(dbCredential.scopes),
      };

      touchApiCredentialLastUsed(dbCredential.id).catch(() => null);
      return next();
    }
  } catch (error) {
    return res.status(503).json({ error: "Auth backend unavailable" });
  }

  const legacyMatch = env.apiKeys.includes(candidate);
  if (legacyMatch) {
    if (!env.allowLegacyApiKeys) {
      return res.status(401).json({
        error: "Legacy API keys are disabled",
      });
    }

    req.apiAuth = {
      keyType: "legacy",
      site: null,
      scopes: new Set(FULL_SCOPES),
    };
    return next();
  }

  const scopedMatch = env.scopedApiKeys.find((credential) => credential.key === candidate);
  if (!scopedMatch) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.apiAuth = {
    keyType: "scoped",
    site: normalizeSite(scopedMatch.site),
    scopes: new Set(scopedMatch.scopes),
  };

  return next();
}

function requireApiScope(scope) {
  return function apiScopeGuard(req, res, next) {
    if (!req.apiAuth) {
      return res.status(500).json({ error: "API auth context missing" });
    }

    if (!hasScope(req.apiAuth, scope)) {
      return res.status(403).json({ error: "Forbidden: insufficient scope" });
    }

    return next();
  };
}

module.exports = {
  requireApiKey,
  requireApiScope,
  isSiteAuthorized,
};
