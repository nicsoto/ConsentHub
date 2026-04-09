const {
  appRole,
  port,
  retentionJobMinutes,
  billingAlertJobMinutes,
  validateConfig,
} = require("./config/env");
const { createApp } = require("./app");
const { startWorkerJobs } = require("./services/startWorkerJobs");

const configErrors = validateConfig();
if (configErrors.length > 0) {
  console.error("[config] invalid configuration:");
  for (const error of configErrors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const app = createApp();

if (appRole === "worker") {
  console.log("APP_ROLE=worker: server web no iniciado en este proceso.");
  process.exit(0);
}

if (appRole === "all") {
  startWorkerJobs(retentionJobMinutes, billingAlertJobMinutes);
  console.log(`[server] APP_ROLE=all: worker jobs started in this process (${retentionJobMinutes}/${billingAlertJobMinutes} min)`);
}

app.listen(port, () => {
  console.log(`ConsentHub SaaS web running on http://localhost:${port}`);
});
