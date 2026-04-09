#!/usr/bin/env node

const { setTimeout: sleep } = require("node:timers/promises");

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const rank = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[rank];
}

function parseScenariosFromEnv() {
  const rawJson = String(process.env.PERF_SCENARIOS_JSON || "").trim();
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("PERF_SCENARIOS_JSON must be a non-empty JSON array");
    }
    return parsed.map(normalizeScenario);
  }

  const endpoints = String(process.env.PERF_ENDPOINTS || "/livez,/readyz")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (endpoints.length === 0) {
    throw new Error("No scenarios configured: use PERF_ENDPOINTS or PERF_SCENARIOS_JSON");
  }

  return endpoints.map((path) => normalizeScenario({ method: "GET", path }));
}

function scenarioKey(scenario) {
  return `${scenario.method} ${scenario.path}`;
}

function parseScenarioBudgetsFromEnv(scenarios) {
  const rawJson = String(process.env.PERF_SCENARIO_BUDGETS_JSON || "").trim();
  if (!rawJson) {
    return [];
  }

  const parsed = JSON.parse(rawJson);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PERF_SCENARIO_BUDGETS_JSON must be a non-empty JSON array");
  }

  const allowedKeys = new Set(scenarios.map((s) => scenarioKey(s)));
  const seen = new Set();

  return parsed.map((input) => {
    const scenario = normalizeScenario(input);
    const key = scenarioKey(scenario);

    if (!allowedKeys.has(key)) {
      throw new Error(`Scenario budget '${key}' does not exist in PERF_SCENARIOS_JSON`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicated scenario budget '${key}' in PERF_SCENARIO_BUDGETS_JSON`);
    }
    seen.add(key);

    const p95Ms = Math.max(1, toNumber(input.p95Ms, Number.NaN));
    const errorRate = Math.max(0, Math.min(1, toNumber(input.errorRate, Number.NaN)));

    if (!Number.isFinite(p95Ms) || !Number.isFinite(errorRate)) {
      throw new Error(`Scenario budget '${key}' requires numeric p95Ms and errorRate`);
    }

    return {
      key,
      p95Ms,
      errorRate,
    };
  });
}

function normalizeScenario(input = {}) {
  const method = String(input.method || "GET").trim().toUpperCase();
  const path = String(input.path || "").trim();
  const headers = input.headers && typeof input.headers === "object" ? { ...input.headers } : {};
  const body = input.body === undefined ? undefined : input.body;
  const expectedStatus = input.expectedStatus === undefined ? undefined : Number(input.expectedStatus);

  if (!path.startsWith("/")) {
    throw new Error(`Invalid scenario path '${path}'. It must start with '/'.`);
  }

  return {
    method,
    path,
    headers,
    body,
    expectedStatus: Number.isFinite(expectedStatus) ? expectedStatus : undefined,
  };
}

async function waitForService(baseUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/livez`);
      if (res.ok) {
        return;
      }
    } catch (_error) {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`Service not ready at ${baseUrl} after ${timeoutMs}ms`);
}

async function main() {
  const baseUrl = String(process.env.PERF_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const scenarios = parseScenariosFromEnv();
  const scenarioBudgets = parseScenarioBudgetsFromEnv(scenarios);

  const totalRequests = Math.max(20, Math.floor(toNumber(process.env.PERF_REQUESTS_TOTAL, 200)));
  const concurrency = Math.max(1, Math.floor(toNumber(process.env.PERF_CONCURRENCY, 20)));
  const p95BudgetMs = Math.max(1, toNumber(process.env.PERF_P95_MS_BUDGET, 250));
  const errorRateBudget = Math.max(0, Math.min(1, toNumber(process.env.PERF_ERROR_RATE_BUDGET, 0.01)));
  const startupTimeoutMs = Math.max(1000, Math.floor(toNumber(process.env.PERF_STARTUP_TIMEOUT_MS, 20000)));

  await waitForService(baseUrl, startupTimeoutMs);

  const latencies = [];
  let errors = 0;
  let sent = 0;
  const scenarioStats = new Map(
    scenarios.map((scenario) => [scenarioKey(scenario), { latencies: [], errors: 0, requests: 0 }]),
  );

  async function hit(index) {
    const scenario = scenarios[index % scenarios.length];
    const started = process.hrtime.bigint();

    try {
      const headers = {
        "x-perf-check": "budget",
        ...(scenario.headers || {}),
      };

      const init = {
        method: scenario.method,
        headers,
      };

      if (scenario.body !== undefined) {
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
        init.body = typeof scenario.body === "string" ? scenario.body : JSON.stringify(scenario.body);
      }

      const res = await fetch(`${baseUrl}${scenario.path}`, init);

      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      latencies.push(elapsedMs);

      const okByStatus = scenario.expectedStatus !== undefined ? res.status === scenario.expectedStatus : res.ok;
      const key = scenarioKey(scenario);
      const stats = scenarioStats.get(key);
      if (stats) {
        stats.latencies.push(elapsedMs);
        stats.requests += 1;
      }
      if (!okByStatus) {
        errors += 1;
        if (stats) {
          stats.errors += 1;
        }
      }
    } catch (_error) {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      latencies.push(elapsedMs);
      const key = scenarioKey(scenario);
      const stats = scenarioStats.get(key);
      if (stats) {
        stats.latencies.push(elapsedMs);
        stats.requests += 1;
        stats.errors += 1;
      }
      errors += 1;
    }
  }

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = sent;
      sent += 1;
      if (index >= totalRequests) {
        break;
      }
      await hit(index);
    }
  });

  await Promise.all(workers);

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const errorRate = totalRequests > 0 ? errors / totalRequests : 0;

  console.log("[perf-budget] summary");
  console.log(`[perf-budget] baseUrl=${baseUrl}`);
  console.log(`[perf-budget] scenarios=${scenarios.map((s) => `${s.method} ${s.path}`).join(",")}`);
  console.log(`[perf-budget] requests=${totalRequests} concurrency=${concurrency}`);
  console.log(`[perf-budget] p50_ms=${p50.toFixed(2)} p95_ms=${p95.toFixed(2)} p99_ms=${p99.toFixed(2)}`);
  console.log(`[perf-budget] errors=${errors} error_rate=${errorRate.toFixed(4)}`);
  console.log(`[perf-budget] budgets: p95_ms<=${p95BudgetMs}, error_rate<=${errorRateBudget}`);

  if (scenarioBudgets.length > 0) {
    console.log("[perf-budget] scenario budgets");
    for (const budget of scenarioBudgets) {
      const stats = scenarioStats.get(budget.key);
      const sortedScenario = stats ? [...stats.latencies].sort((a, b) => a - b) : [];
      const scenarioP95 = percentile(sortedScenario, 95);
      const scenarioErrorRate = stats && stats.requests > 0 ? stats.errors / stats.requests : 0;
      console.log(
        `[perf-budget] scenario=${budget.key} requests=${stats ? stats.requests : 0} p95_ms=${scenarioP95.toFixed(2)} error_rate=${scenarioErrorRate.toFixed(4)} budgets: p95_ms<=${budget.p95Ms}, error_rate<=${budget.errorRate}`,
      );
    }
  }

  const failures = [];
  if (p95 > p95BudgetMs) {
    failures.push(`p95 ${p95.toFixed(2)}ms exceeded budget ${p95BudgetMs}ms`);
  }
  if (errorRate > errorRateBudget) {
    failures.push(`error_rate ${errorRate.toFixed(4)} exceeded budget ${errorRateBudget}`);
  }

  for (const budget of scenarioBudgets) {
    const stats = scenarioStats.get(budget.key);
    const sortedScenario = stats ? [...stats.latencies].sort((a, b) => a - b) : [];
    const scenarioP95 = percentile(sortedScenario, 95);
    const scenarioErrorRate = stats && stats.requests > 0 ? stats.errors / stats.requests : 0;

    if (scenarioP95 > budget.p95Ms) {
      failures.push(`scenario '${budget.key}' p95 ${scenarioP95.toFixed(2)}ms exceeded budget ${budget.p95Ms}ms`);
    }
    if (scenarioErrorRate > budget.errorRate) {
      failures.push(
        `scenario '${budget.key}' error_rate ${scenarioErrorRate.toFixed(4)} exceeded budget ${budget.errorRate}`,
      );
    }
  }

  if (failures.length > 0) {
    for (const msg of failures) {
      console.error(`[perf-budget] FAIL: ${msg}`);
    }
    process.exit(1);
  }

  console.log("[perf-budget] PASS");
}

main().catch((error) => {
  console.error(`[perf-budget] ERROR: ${error.message}`);
  process.exit(1);
});
