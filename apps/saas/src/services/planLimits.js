function getPlanLimits(plan) {
  const normalized = String(plan || "free").toLowerCase();

  if (normalized === "starter") {
    return {
      monthlyEvents: 20000,
      csvExportAllowed: true,
      historyDays: 365,
    };
  }

  if (normalized === "pro") {
    return {
      monthlyEvents: 200000,
      csvExportAllowed: true,
      historyDays: 3650,
    };
  }

  return {
    monthlyEvents: 1000,
    csvExportAllowed: false,
    historyDays: 30,
  };
}

function resolveEffectivePlan(billing = {}, now = new Date()) {
  const plan = String(billing.plan || "free").toLowerCase();
  const status = String(billing.billingStatus || "free").toLowerCase();
  const graceRaw = billing.gracePeriodEndsAt;
  const graceDate = graceRaw ? new Date(graceRaw) : null;

  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
    return "free";
  }

  if (status === "past_due") {
    if (!graceDate || Number.isNaN(graceDate.getTime())) {
      return "free";
    }
    return graceDate > now ? plan : "free";
  }

  return plan;
}

function getPlanLimitsForBilling(billing = {}, now = new Date()) {
  const effectivePlan = resolveEffectivePlan(billing, now);
  return {
    effectivePlan,
    limits: getPlanLimits(effectivePlan),
  };
}

module.exports = { getPlanLimits, resolveEffectivePlan, getPlanLimitsForBilling };
