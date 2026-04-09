const { recordHttpRequest } = require("../lib/metrics");

function getRouteLabel(req, statusCode) {
  if (req.route && req.route.path) {
    return `${req.baseUrl || ""}${req.route.path}`;
  }

  if (statusCode === 404) {
    return "unmatched";
  }

  return String(req.path || req.originalUrl || "unknown").split("?")[0] || "unknown";
}

function httpMetricsMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const elapsedNs = Number(process.hrtime.bigint() - startedAt);
    const durationMs = elapsedNs / 1_000_000;

    recordHttpRequest({
      method: req.method,
      route: getRouteLabel(req, res.statusCode),
      statusCode: res.statusCode,
      durationMs,
    });
  });

  return next();
}

module.exports = { httpMetricsMiddleware };
