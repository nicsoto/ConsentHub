const counters = new Map();
const durationHistogramBucketsMs = [25, 50, 100, 250, 500, 1000, 2500, 5000];

function sanitizeMetricName(name) {
  return String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_:]/g, "_");
}

function normalizeLabels(labels = {}) {
  const pairs = Object.entries(labels)
    .map(([key, value]) => [String(key || "").trim(), String(value ?? "").trim()])
    .filter(([key]) => key.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  return Object.fromEntries(pairs);
}

function labelsKey(labels = {}) {
  const normalized = normalizeLabels(labels);
  return Object.entries(normalized)
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

function incCounter(name, labels = {}, amount = 1) {
  const metricName = sanitizeMetricName(name);
  if (!metricName || !Number.isFinite(Number(amount))) {
    return;
  }

  const key = `${metricName}::${labelsKey(labels)}`;
  const entry = counters.get(key) || {
    name: metricName,
    labels: normalizeLabels(labels),
    value: 0,
  };

  entry.value += Number(amount);
  counters.set(key, entry);
}

function recordHttpRequest({ method, route, statusCode, durationMs }) {
  const labels = {
    method: String(method || "GET").toUpperCase(),
    route: String(route || "unknown"),
    status: String(statusCode || "0"),
  };
  const duration = Math.max(0, Number(durationMs || 0));

  incCounter("consenthub_http_requests_total", labels, 1);
  for (const upperBound of durationHistogramBucketsMs) {
    if (duration <= upperBound) {
      incCounter("consenthub_http_request_duration_ms_bucket", { ...labels, le: String(upperBound) }, 1);
    }
  }
  incCounter("consenthub_http_request_duration_ms_bucket", { ...labels, le: "+Inf" }, 1);
  incCounter("consenthub_http_request_duration_ms_sum", labels, duration);
  incCounter("consenthub_http_request_duration_ms_count", labels, 1);
}

function recordRateLimitRejection({ keyPrefix, route }) {
  incCounter(
    "consenthub_rate_limit_rejections_total",
    {
      keyPrefix: String(keyPrefix || "global"),
      route: String(route || "unknown"),
    },
    1
  );
}

function escapeLabelValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function renderLabels(labels = {}) {
  const entries = Object.entries(normalizeLabels(labels));
  if (entries.length === 0) {
    return "";
  }

  const encoded = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");

  return `{${encoded}}`;
}

function renderPrometheus() {
  const lines = [
    "# HELP consenthub_http_requests_total Total HTTP requests handled",
    "# TYPE consenthub_http_requests_total counter",
    "# HELP consenthub_http_request_duration_ms HTTP request duration in milliseconds",
    "# TYPE consenthub_http_request_duration_ms histogram",
    "# HELP consenthub_rate_limit_rejections_total Total rate-limit rejections",
    "# TYPE consenthub_rate_limit_rejections_total counter",
  ];

  const sorted = Array.from(counters.values()).sort((a, b) => {
    if (a.name !== b.name) {
      return a.name.localeCompare(b.name);
    }
    return labelsKey(a.labels).localeCompare(labelsKey(b.labels));
  });

  for (const entry of sorted) {
    lines.push(`${entry.name}${renderLabels(entry.labels)} ${entry.value}`);
  }

  lines.push("");
  return lines.join("\n");
}

function resetMetricsForTests() {
  counters.clear();
}

module.exports = {
  recordHttpRequest,
  recordRateLimitRejection,
  renderPrometheus,
  resetMetricsForTests,
};
