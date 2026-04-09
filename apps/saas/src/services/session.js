const crypto = require("crypto");

const SESSION_COOKIE = "consenthub_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function normalizeRole(role) {
  const value = String(role || "admin").trim().toLowerCase();
  const allowed = new Set(["admin", "analyst", "billing_manager", "operator"]);
  return allowed.has(value) ? value : "admin";
}

function normalizeSites(sites) {
  if (!Array.isArray(sites)) {
    return ["*"];
  }

  const clean = [...new Set(sites.map((site) => String(site || "").trim().toLowerCase()).filter(Boolean))];
  if (clean.length === 0) {
    return ["*"];
  }
  if (clean.includes("*")) {
    return ["*"];
  }
  return clean;
}

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch (_error) {
    return false;
  }
}

function createSessionValue(email, secret, claims = {}) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = JSON.stringify({
    email: String(email || "").trim().toLowerCase(),
    exp,
    role: normalizeRole(claims.role),
    sites: normalizeSites(claims.sites),
  });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = sign(encoded, secret);
  return `v2|${encoded}|${signature}`;
}

function verifySessionValue(raw, secret) {
  if (!raw) {
    return null;
  }

  // Preferred modern format with role + site claims.
  if (raw.startsWith("v2|")) {
    const parts = raw.split("|");
    if (parts.length !== 3) {
      return null;
    }

    const [, encoded, signature] = parts;
    const expected = sign(encoded, secret);
    if (!safeEqualHex(signature, expected)) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      const email = String(parsed.email || "").trim().toLowerCase();
      const exp = Number(parsed.exp);
      if (!email || !Number.isFinite(exp) || Date.now() > exp) {
        return null;
      }

      return {
        email,
        exp,
        role: normalizeRole(parsed.role),
        sites: normalizeSites(parsed.sites),
      };
    } catch (_error) {
      return null;
    }
  }

  // Legacy format compatibility: email|exp|signature.
  const parts = raw.split("|");
  if (parts.length !== 3) {
    return null;
  }

  const [email, expRaw, signature] = parts;
  const payload = `${email}|${expRaw}`;
  const expected = sign(payload, secret);

  if (!safeEqualHex(signature, expected)) {
    return null;
  }

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) {
    return null;
  }

  return { email, exp, role: "admin", sites: ["*"] };
}

function shouldRefreshSession(session) {
  return session.exp - Date.now() < SESSION_REFRESH_THRESHOLD_MS;
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(";").reduce((acc, chunk) => {
    const [k, ...rest] = chunk.trim().split("=");
    if (!k) {
      return acc;
    }

    acc[k] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [current, cookieValue]);
}

function attachSessionCookie(res, value, isSecure) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];

  if (isSecure) {
    attrs.push("Secure");
  }

  appendSetCookie(res, attrs.join("; "));
}

function clearSessionCookie(res, isSecure) {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];

  if (isSecure) {
    attrs.push("Secure");
  }

  appendSetCookie(res, attrs.join("; "));
}

module.exports = {
  SESSION_COOKIE,
  createSessionValue,
  verifySessionValue,
  shouldRefreshSession,
  parseCookies,
  attachSessionCookie,
  clearSessionCookie,
};
