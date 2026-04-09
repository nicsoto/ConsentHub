const { startRetentionJob } = require("./retentionJob");
const { startBillingAlertJob } = require("./billingAlertJob");
const { createAuditLog } = require("../data/store");
const {
  registerWorkerJob,
  markWorkerJobStarted,
  markWorkerJobSucceeded,
  markWorkerJobFailed,
} = require("./workerJobStatus");

async function createWorkerJobAudit(jobName, outcome, metadata = {}) {
  try {
    await createAuditLog({
      actorEmail: "system@worker.local",
      action: `worker.job.${jobName}.${outcome}`,
      site: "",
      requestId: "",
      metadata,
    });
  } catch (_error) {
    // best-effort only
  }
}

function startWorkerJobs(retentionJobMinutes, billingAlertJobMinutes) {
  registerWorkerJob("retention", {
    intervalMinutes: retentionJobMinutes,
  });

  registerWorkerJob("billing-alerts", {
    intervalMinutes: billingAlertJobMinutes,
  });

  const retention = startRetentionJob(retentionJobMinutes, {
    onStart: () => markWorkerJobStarted("retention"),
    onSuccess: (result, durationMs) => {
      markWorkerJobSucceeded("retention", result, durationMs);
      createWorkerJobAudit("retention", "success", {
        durationMs,
        deletedTotal: Number(result?.deletedTotal || 0),
      });
    },
    onError: (error, durationMs) => {
      markWorkerJobFailed("retention", error, durationMs);
      createWorkerJobAudit("retention", "error", {
        durationMs,
        errorMessage: String(error && error.message ? error.message : "unknown_error"),
      });
    },
  });

  const billingAlerts = startBillingAlertJob(billingAlertJobMinutes, {
    onStart: () => markWorkerJobStarted("billing-alerts"),
    onSuccess: (result, durationMs) => {
      markWorkerJobSucceeded("billing-alerts", result, durationMs);
      createWorkerJobAudit("billing_alerts", "success", {
        durationMs,
        escalatedCount: Number(result?.escalatedCount || 0),
      });
    },
    onError: (error, durationMs) => {
      markWorkerJobFailed("billing-alerts", error, durationMs);
      createWorkerJobAudit("billing_alerts", "error", {
        durationMs,
        errorMessage: String(error && error.message ? error.message : "unknown_error"),
      });
    },
  });

  return {
    retention,
    billingAlerts,
  };
}

module.exports = { startWorkerJobs };
