const crypto = require("node:crypto");

function requestIdMiddleware(req, res, next) {
  const incoming = String(req.get("x-request-id") || "").trim();
  const requestId = incoming || crypto.randomUUID();

  req.requestId = requestId;
  res.set("x-request-id", requestId);
  next();
}

module.exports = { requestIdMiddleware };
