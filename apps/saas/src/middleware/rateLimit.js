const { consumeRateLimitBucket, purgeExpiredRateLimitBuckets } = require("../data/store");
const { recordRateLimitRejection } = require("../lib/metrics");

setInterval(() => {
  purgeExpiredRateLimitBuckets(new Date()).catch(() => null);
}, 5 * 60 * 1000).unref();

function createRateLimit(options = {}) {
  const windowMsResolver = typeof options.windowMs === "function"
    ? options.windowMs
    : () => Number(options.windowMs || 60_000);
  const maxResolver = typeof options.max === "function"
    ? options.max
    : () => Number(options.max || 120);
  const keyPrefix = String(options.keyPrefix || "global").trim();
  const keyResolver = typeof options.keyResolver === "function"
    ? options.keyResolver
    : (req) => req.ip || req.connection?.remoteAddress || "unknown";

  return async function rateLimit(req, res, next) {
    const windowMs = Number(windowMsResolver(req) || 60_000);
    const max = Number(maxResolver(req) || 120);
    const identity = String(keyResolver(req) || "unknown");
    const bucketKey = `${keyPrefix}:${identity}`;

    let result;
    try {
      result = await consumeRateLimitBucket(bucketKey, {
        windowMs,
        max,
        now: new Date(),
      });
    } catch (error) {
      // Fail-open to avoid blocking traffic if the limiter backend is temporarily unavailable.
      return next();
    }

    if (!result.allowed) {
      recordRateLimitRejection({
        keyPrefix,
        route: String(req.path || req.originalUrl || "unknown").split("?")[0] || "unknown",
      });
      res.setHeader("Retry-After", String(Math.max(result.retryAfterSeconds, 1)));
      return res.status(429).json({
        error: "Too many requests",
        retryAfterSeconds: Math.max(result.retryAfterSeconds, 1),
      });
    }

    return next();
  };
}

module.exports = { createRateLimit };
