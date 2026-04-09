const { spawn } = require("node:child_process");

const WEB_PORT = Number(process.env.SMOKE_WEB_PORT || 8799);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNode(args, env = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill("SIGTERM");
      resolve({
        code: null,
        timedOut: true,
        stdout,
        stderr,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("exit", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({
        code,
        timedOut: false,
        stdout,
        stderr,
      });
    });
  });
}

async function waitForJson(url, retries = 20, delayMs = 200) {
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(url);
      const json = await res.json();
      return { status: res.status, body: json };
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw lastError || new Error(`Unable to reach ${url}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  console.log("[smoke] validating role gates");

  const serverAsWorker = await runNode(["src/server.js"], { APP_ROLE: "worker" });
  assert(serverAsWorker.code === 0, "server should exit 0 when APP_ROLE=worker");
  assert(
    serverAsWorker.stdout.includes("APP_ROLE=worker"),
    "server output should mention APP_ROLE=worker behavior"
  );

  const workerAsWeb = await runNode(["src/worker.js"], { APP_ROLE: "web" });
  assert(workerAsWeb.code === 0, "worker should exit 0 when APP_ROLE=web");
  assert(
    workerAsWeb.stdout.includes("APP_ROLE=web"),
    "worker output should mention APP_ROLE=web behavior"
  );

  console.log("[smoke] validating web health endpoints");

  const webProcess = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      APP_ROLE: "web",
      PORT: String(WEB_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let webStdErr = "";
  webProcess.stderr.on("data", (chunk) => {
    webStdErr += chunk.toString();
  });

  try {
    const live = await waitForJson(`${WEB_URL}/livez`);
    const ready = await waitForJson(`${WEB_URL}/readyz`);
    const health = await waitForJson(`${WEB_URL}/health`);

    assert(live.status === 200, "/livez must return 200");
    assert(live.body.ok === true, "/livez must report ok=true");
    assert(live.body.role === "web", "/livez must report role=web");

    assert(ready.status === 200, "/readyz must return 200 in local smoke");
    assert(ready.body.ok === true, "/readyz must report ok=true in local smoke");
    assert(ready.body.checks && ready.body.checks.db, "/readyz must include db check");

    assert(health.status === 200, "/health must return 200");
    assert(health.body.checks && health.body.checks.db, "/health must include db check");

    console.log("[smoke] ok: role split and health endpoints validated");
  } finally {
    webProcess.kill("SIGTERM");
    await sleep(200);
  }

  if (webStdErr.trim()) {
    console.log("[smoke] web stderr captured:");
    console.log(webStdErr.trim());
  }
}

main().catch((error) => {
  console.error("[smoke] failed:", error.message);
  process.exit(1);
});
