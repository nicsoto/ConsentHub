const { spawn } = require("node:child_process");

const WEB_PORT = Number(process.env.SMOKE_WEB_PORT || 8787);
const WEB_URL = process.env.SMOKE_WEB_URL || `http://127.0.0.1:${WEB_PORT}`;
const PROM_URL = process.env.SMOKE_PROM_URL || "http://127.0.0.1:9090";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForText(url, retries = 25, delayMs = 400) {
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      return { status: res.status, text };
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw lastError || new Error(`Unable to reach ${url}`);
}

async function waitForPromQuery(query, retries = 30, delayMs = 1500, allowEmpty = false) {
  let lastPayload = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const url = new URL(`${PROM_URL}/api/v1/query`);
    url.searchParams.set("query", query);

    try {
      const res = await fetch(url);
      const payload = await res.json();
      lastPayload = payload;

      if (res.status === 200 && payload.status === "success") {
        const data = payload.data || {};
        const result = Array.isArray(data.result) ? data.result : [];
        if (allowEmpty || result.length > 0) {
          return payload;
        }
      }
    } catch (_error) {
      // Keep retrying to absorb startup/scrape delays.
    }

    await sleep(delayMs);
  }

  throw new Error(`Prometheus query produced no series: ${query}. Last payload: ${JSON.stringify(lastPayload || {})}`);
}

async function ensurePrometheusReady() {
  const readiness = await waitForText(`${PROM_URL}/-/ready`, 20, 500);
  assert(readiness.status === 200, "Prometheus /-/ready must return 200");
}

async function hit(url, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await fetch(url);
  }
}

async function main() {
  console.log("[smoke] observability: validating /metrics and Prometheus wiring");

  const webProcess = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      APP_ROLE: "web",
      PORT: String(WEB_PORT),
      METRICS_ENABLED: process.env.METRICS_ENABLED || "true",
      NODE_ENV: process.env.NODE_ENV || "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let webStderr = "";
  webProcess.stderr.on("data", (chunk) => {
    webStderr += chunk.toString();
  });

  try {
    const metricsRes = await waitForText(`${WEB_URL}/metrics`);
    assert(metricsRes.status === 200, "/metrics must return 200");
    assert(metricsRes.text.includes("consenthub_http_requests_total"), "/metrics must include request counter");

    await hit(`${WEB_URL}/livez`, 5);
    await hit(`${WEB_URL}/readyz`, 3);
    await hit(`${WEB_URL}/dashboard/worker-jobs-history`, 1);

    await ensurePrometheusReady();

    await waitForPromQuery("consenthub:http_requests:rate5m");
    // This series can be empty when no 5xx traffic has occurred, which is still healthy.
    await waitForPromQuery("consenthub:http_5xx_ratio:rate5m", 30, 1500, true);
    await waitForPromQuery("consenthub:http_latency_p95_ms:5m");

    console.log("[smoke] ok: metrics endpoint and Prometheus recording rules are wired");
  } finally {
    webProcess.kill("SIGTERM");
    await sleep(200);
  }

  if (webStderr.trim()) {
    console.log("[smoke] web stderr captured:");
    console.log(webStderr.trim());
  }
}

main().catch((error) => {
  console.error("[smoke] failed:", error.message);
  process.exit(1);
});
