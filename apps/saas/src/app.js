const express = require("express");
const cors = require("cors");
const { nodeEnv, corsAllowedOrigins } = require("./config/env");
const { requestIdMiddleware } = require("./middleware/requestId");
const { httpMetricsMiddleware } = require("./middleware/httpMetrics");
const logger = require("./lib/logger");
const healthRoutes = require("./routes/health");
const metricsRoutes = require("./routes/metrics");
const consentRoutes = require("./routes/consent");
const privacyRoutes = require("./routes/privacy");
const marketingRoutes = require("./routes/marketing");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const onboardingRoutes = require("./routes/onboarding");
const customerPortalRoutes = require("./routes/customerPortal");
const { billingRouter, billingWebhookRouter } = require("./routes/billing");

function createCorsMiddleware() {
  if (nodeEnv !== "production") {
    return cors();
  }

  return cors({
    origin: corsAllowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key", "x-request-id"],
    exposedHeaders: ["x-request-id"],
  });
}

function createApp() {
  const app = express();

  app.use(createCorsMiddleware());
  app.use(requestIdMiddleware);
  app.use(httpMetricsMiddleware);
  app.use(billingWebhookRouter);
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use(healthRoutes);
  app.use(metricsRoutes);
  app.use(marketingRoutes);
  app.use(consentRoutes);
  app.use(privacyRoutes);
  app.use(onboardingRoutes);
  app.use(authRoutes);
  app.use(dashboardRoutes);
  app.use(billingRouter);
  app.use(customerPortalRoutes);

  app.use((err, req, res, _next) => {
    const requestId = String(req.requestId || "").trim() || "unknown-request";
    const isInvalidJson =
      err &&
      err.type === "entity.parse.failed" &&
      typeof err.status === "number" &&
      err.status === 400;

    if (isInvalidJson) {
      logger.error({
        event: "invalid_json_payload",
        requestId,
        method: req.method,
        path: req.originalUrl,
        errorName: err && err.name ? String(err.name) : "SyntaxError",
        errorMessage: err && err.message ? String(err.message) : "invalid-json",
      });

      return res.status(400).json({
        error: "Invalid JSON payload",
        requestId,
      });
    }

    logger.error({
      event: "unhandled_error",
      requestId,
      method: req.method,
      path: req.originalUrl,
      errorName: err && err.name ? String(err.name) : "Error",
      errorMessage: err && err.message ? String(err.message) : "unknown",
    });

    res.status(500).json({
      error: "Internal server error",
      requestId,
    });
  });

  return app;
}

module.exports = { createApp };
