const crypto = require("crypto");
const { parseCookies } = require("../services/session");
const { sessionSecret, isSecureCookies } = require("../config/env");

const CSRF_COOKIE = "consenthub_csrf";

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

function sign(nonce) {
  return crypto.createHmac("sha256", sessionSecret).update(nonce).digest("hex");
}

function issueToken() {
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = sign(nonce);
  return `${nonce}.${signature}`;
}

function isValidToken(token) {
  if (!token || !token.includes(".")) {
    return false;
  }

  const [nonce, signature] = token.split(".");
  if (!nonce || !signature) {
    return false;
  }

  const expected = sign(nonce);
  if (expected.length !== signature.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch (_error) {
    return false;
  }
}

function ensureCsrfCookie(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || "");
  let token = cookies[CSRF_COOKIE];

  if (!token || !isValidToken(token)) {
    token = issueToken();
    const attrs = [
      `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=86400",
    ];

    if (isSecureCookies) {
      attrs.push("Secure");
    }

    appendSetCookie(res, attrs.join("; "));
  }

  req.csrfToken = token;
  next();
}

function requireCsrf(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || "");
  const cookieToken = cookies[CSRF_COOKIE] || "";
  const bodyToken = String(req.body?._csrf || "");

  if (!cookieToken || !bodyToken || cookieToken !== bodyToken || !isValidToken(cookieToken)) {
    return res.status(403).send("CSRF token invalido");
  }

  next();
}

module.exports = {
  ensureCsrfCookie,
  requireCsrf,
};
