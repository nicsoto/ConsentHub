const {
  runBillingAlertEscalation,
  getCriticalAlertsEligibleForEmail,
  markCriticalAlertsEmailSent,
} = require("../data/store");
const { billingCriticalEmailCooldownMinutes } = require("../config/env");
const { sendCriticalBillingAlertsEmail } = require("./email");

function startBillingAlertJob(intervalMinutes, hooks = {}) {
  const everyMs = Math.max(Number(intervalMinutes || 1440), 15) * 60 * 1000;

  const run = async () => {
    const startedAt = Date.now();
    if (typeof hooks.onStart === "function") {
      hooks.onStart();
    }

    try {
      const result = await runBillingAlertEscalation();
      if (result.escalatedCount > 0) {
        console.warn(`[billing-alerts] Escaladas ${result.escalatedCount} alertas a CRITICO`);
        const eligibleAlerts = await getCriticalAlertsEligibleForEmail(
          result.escalatedAlerts || [],
          billingCriticalEmailCooldownMinutes
        );

        if (eligibleAlerts.length > 0) {
          const emailResult = await sendCriticalBillingAlertsEmail(eligibleAlerts);
          if (!emailResult.sent) {
            console.warn(`[billing-alerts] No se envio email de alertas criticas: ${emailResult.reason || "unknown_reason"}`);
          } else {
            await markCriticalAlertsEmailSent(eligibleAlerts);
          }
        }
      }

      if (typeof hooks.onSuccess === "function") {
        hooks.onSuccess(result, Date.now() - startedAt);
      }
    } catch (error) {
      console.error("[billing-alerts] escalation failed", error.message);

      if (typeof hooks.onError === "function") {
        hooks.onError(error, Date.now() - startedAt);
      }
    }
  };

  const timer = setInterval(run, everyMs);
  timer.unref();

  return { run, timer };
}

module.exports = { startBillingAlertJob };
