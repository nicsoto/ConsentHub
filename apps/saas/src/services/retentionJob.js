const { runRetentionCleanup } = require("../data/store");

function startRetentionJob(intervalMinutes, hooks = {}) {
  const everyMs = Math.max(Number(intervalMinutes || 60), 5) * 60 * 1000;

  const run = async () => {
    const startedAt = Date.now();
    if (typeof hooks.onStart === "function") {
      hooks.onStart();
    }

    try {
      const result = await runRetentionCleanup();
      if (result.deletedTotal > 0) {
        console.log(`[retention] Deleted ${result.deletedTotal} old events`);
      }

      if (typeof hooks.onSuccess === "function") {
        hooks.onSuccess(result, Date.now() - startedAt);
      }
    } catch (error) {
      console.error("[retention] cleanup failed", error.message);

      if (typeof hooks.onError === "function") {
        hooks.onError(error, Date.now() - startedAt);
      }
    }
  };

  const timer = setInterval(run, everyMs);
  timer.unref();

  return { run, timer };
}

module.exports = { startRetentionJob };
