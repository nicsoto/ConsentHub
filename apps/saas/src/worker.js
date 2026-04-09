const {
  appRole,
  retentionJobMinutes,
  billingAlertJobMinutes,
  validateConfig,
} = require("./config/env");
const { startWorkerJobs } = require("./services/startWorkerJobs");

const configErrors = validateConfig();
if (configErrors.length > 0) {
  console.error("[config] invalid configuration:");
  for (const error of configErrors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (appRole === "web") {
  console.log("APP_ROLE=web: worker jobs no iniciados en este proceso.");
  process.exit(0);
}

startWorkerJobs(retentionJobMinutes, billingAlertJobMinutes);

console.log(`[worker] retention job started (every ${retentionJobMinutes} minutes)`);
console.log(`[worker] billing-alerts job started (every ${billingAlertJobMinutes} minutes)`);

// Keep process alive for interval-based jobs.
setInterval(() => {
  // heartbeat no-op
}, 60 * 60 * 1000);
