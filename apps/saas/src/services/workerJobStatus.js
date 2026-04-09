const jobs = {};

function normalizeJobName(name) {
  return String(name || "").trim();
}

function registerWorkerJob(name, metadata = {}) {
  const jobName = normalizeJobName(name);
  if (!jobName) {
    throw new Error("job name is required");
  }

  const existing = jobs[jobName];
  if (existing) {
    return existing;
  }

  const registeredAt = new Date().toISOString();
  const record = {
    name: jobName,
    intervalMinutes: Number(metadata.intervalMinutes || 0),
    registeredAt,
    isRunning: false,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastRunDurationMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: "",
    lastResult: null,
    runCount: 0,
    successCount: 0,
    errorCount: 0,
    status: "idle",
  };

  jobs[jobName] = record;
  return record;
}

function markWorkerJobStarted(name, when = new Date()) {
  const jobName = normalizeJobName(name);
  const row = jobs[jobName];
  if (!row) {
    return;
  }

  row.isRunning = true;
  row.status = "running";
  row.runCount += 1;
  row.lastRunStartedAt = when.toISOString();
}

function markWorkerJobSucceeded(name, result = null, durationMs = null, when = new Date()) {
  const jobName = normalizeJobName(name);
  const row = jobs[jobName];
  if (!row) {
    return;
  }

  row.isRunning = false;
  row.status = "ok";
  row.successCount += 1;
  row.lastRunFinishedAt = when.toISOString();
  row.lastSuccessAt = when.toISOString();
  row.lastErrorMessage = "";
  row.lastResult = result;
  row.lastRunDurationMs = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : null;
}

function markWorkerJobFailed(name, error, durationMs = null, when = new Date()) {
  const jobName = normalizeJobName(name);
  const row = jobs[jobName];
  if (!row) {
    return;
  }

  row.isRunning = false;
  row.status = "error";
  row.errorCount += 1;
  row.lastRunFinishedAt = when.toISOString();
  row.lastErrorAt = when.toISOString();
  row.lastErrorMessage = String(error && error.message ? error.message : error || "unknown_error");
  row.lastRunDurationMs = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : null;
}

function getWorkerJobsStatus() {
  const entries = Object.values(jobs)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({ ...row }));

  return {
    totalJobs: entries.length,
    jobs: entries,
  };
}

function resetWorkerJobsStatusForTests() {
  for (const key of Object.keys(jobs)) {
    delete jobs[key];
  }
}

module.exports = {
  registerWorkerJob,
  markWorkerJobStarted,
  markWorkerJobSucceeded,
  markWorkerJobFailed,
  getWorkerJobsStatus,
  resetWorkerJobsStatusForTests,
};
