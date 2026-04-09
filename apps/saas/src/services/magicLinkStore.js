const crypto = require("crypto");
const {
  saveMagicLinkToken,
  consumeMagicLinkToken,
  purgeExpiredMagicLinkTokens,
} = require("../data/store");

const TOKEN_TTL_MS = 15 * 60 * 1000;

async function issueMagicToken(email) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  await saveMagicLinkToken(token, email, new Date(expiresAt));
  return { token, expiresAt };
}

async function consumeMagicToken(token) {
  return consumeMagicLinkToken(token, new Date());
}

async function purgeExpiredTokens() {
  return purgeExpiredMagicLinkTokens(new Date());
}

setInterval(() => {
  purgeExpiredTokens().catch(() => null);
}, 60 * 1000).unref();

module.exports = {
  issueMagicToken,
  consumeMagicToken,
};
