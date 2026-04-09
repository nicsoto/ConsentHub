# ConsentHub Observability Runbook

This runbook defines first-response actions for the Prometheus alerts and dashboards included in this repository.

## Scope

Applies to:

- API process health and readiness.
- HTTP reliability and latency metrics.
- Dashboard/audit endpoint saturation (rate-limits).

Primary artifacts:

- Prometheus rules: `ops/prometheus/recording.rules.yml`, `ops/prometheus/alerts.rules.yml`
- Grafana dashboard: `ops/grafana/consenthub-overview.dashboard.json`

## Quick Triage (First 5 Minutes)

1. Confirm current service role topology (`APP_ROLE=web|worker|all`) and recent deployments.
2. Check `/readyz` and `/livez` for the web process.
3. Open Grafana dashboard and review:
   - 5xx ratio
   - p95 latency
   - /readyz 503 rate
   - top routes by request rate
4. Inspect recent structured logs for matching `requestId` and events:
   - `readiness_check`
   - `unhandled_error`
   - `invalid_json_payload`

## Alert Playbooks

### Alert: `ConsentHubHigh5xxRate`

Trigger meaning:

- Global 5xx ratio over threshold for sustained window.

Checks:

1. Query top failing routes:
   - `sum by (route, status) (rate(consenthub_http_requests_total{status=~"5.."}[5m]))`
2. Compare traffic and failures:
   - `consenthub:http_requests:rate5m`
   - `consenthub:http_5xx_requests:rate5m`
3. Validate dependency readiness on affected pods/instances (`/readyz`).

Likely causes:

- DB timeouts or query errors.
- Stripe/billing dependency failures (if readiness checks are enabled).
- Regression in high-traffic route.

Immediate mitigations:

- Roll back latest deployment if correlated with release.
- Temporarily shift traffic away from unhealthy instances.
- If issue is dependency-side, degrade non-critical paths while recovering core flow.

### Alert: `ConsentHubReadyzUnavailable`

Trigger meaning:

- Readiness endpoint returning 503 continuously.

Checks:

1. Call `/readyz` and inspect `checks.db` and `checks.stripe` details (`reason`, `durationMs`).
2. Validate DB connectivity from process environment.
3. Confirm Stripe config/client availability when strict readiness for Stripe is enabled.

Likely causes:

- DB connection or query failure.
- DB/Stripe timeout threshold too aggressive for current conditions.
- Missing Stripe config when strict mode is enabled.

Immediate mitigations:

- Restore dependency connectivity first.
- If intentionally degraded dependency, consider disabling strict readiness check only under incident approval.

### Alert: `ConsentHubHighP95Latency`

Trigger meaning:

- Global p95 latency above threshold for sustained period.

Checks:

1. Confirm p95 trend and compare with request rate spikes.
2. Identify high-volume routes from dashboard table.
3. Inspect saturation indicators (CPU/memory/DB pool) externally if available.

Likely causes:

- Capacity saturation under traffic burst.
- Slow downstream calls.
- Inefficient query paths after release.

Immediate mitigations:

- Scale out web instances.
- Rate-limit/queue non-critical workloads.
- Roll back recent performance-sensitive changes.

### Alert: `ConsentHubDashboardRateLimited`

Trigger meaning:

- Dashboard audit/history endpoints are being throttled persistently.

Checks:

1. Review rejection series:
   - `consenthub:dashboard_rate_limit_rejections:rate5m`
2. Identify source actor/IP patterns in access logs.
3. Confirm if there is expected export activity (CSV/automation).

Likely causes:

- Aggressive polling/export scripts.
- Shared admin account from multiple IPs.
- Too strict `AUDIT_LOGS_RATE_LIMIT_MAX` for current usage.

Immediate mitigations:

- Reduce client polling/export frequency.
- Temporarily increase rate-limit threshold with explicit expiration and follow-up.
- Create dedicated credentials/workflow for batch exports.

## Verification Commands

Local verification:

```bash
npm run validate:prometheus
npm run verify:observability
```

Local stack + smokes:

```bash
npm run dev:observability
```

Manual checks:

```bash
curl -fsS http://localhost:8787/metrics | head
curl -fsS http://localhost:9090/-/ready
curl -fsS "http://localhost:9090/api/v1/query?query=consenthub:http_5xx_ratio:rate5m"
```

## Escalation Guidelines

Escalate immediately when:

- `ConsentHubReadyzUnavailable` persists beyond 10 minutes.
- 5xx ratio exceeds threshold and impacts core consent ingestion.
- p95 latency breach coincides with error-rate increase.

Include in escalation note:

1. Alert name and first firing timestamp.
2. Current values for ratio/latency/readiness metrics.
3. Suspected blast radius (routes, tenants, regions if applicable).
4. Mitigation actions already applied.

## Post-Incident Checklist

1. Add/adjust alert threshold only with rationale and expected trade-off.
2. Capture root cause and create prevention task.
3. Update this runbook if a gap was discovered.
4. Add regression test or smoke probe when incident came from code/config drift.

Postmortem template and incident folder:

- Template: `ops/incidents/postmortem-template.md`
- Incident docs index: `ops/incidents/README.md`
