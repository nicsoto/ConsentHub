# Incident Postmortem Template

## Metadata

- Incident ID:
- Date/Time (UTC):
- Severity: Sev-1 | Sev-2 | Sev-3
- Status: Draft | Final
- Owner:
- Reviewers:

## Summary

- What happened:
- Customer impact:
- Business impact:
- Detection method:
- Resolution summary:

## Timeline (UTC)

| Time | Event | Actor |
| --- | --- | --- |
| HH:MM | Alert fired | on-call |
| HH:MM | Triage started | on-call |
| HH:MM | Mitigation applied | owner |
| HH:MM | Service recovered | owner |
| HH:MM | Incident closed | incident commander |

## Impact Analysis

- Start of impact:
- End of impact:
- Duration:
- Affected routes/features:
- Affected tenants/sites:
- Approx. request volume affected:

## Detection and Alerting

- Which alert fired first:
- Were alerts timely and actionable:
- False-positive/false-negative observations:
- Metrics used during investigation:
  - consenthub:http_5xx_ratio:rate5m
  - consenthub:http_latency_p95_ms:5m
  - consenthub:readyz_503:rate5m
  - consenthub:dashboard_rate_limit_rejections:rate5m

## Root Cause Analysis

### Immediate cause

- 

### Contributing factors

- 

### Why it was possible (systemic)

- 

## What Went Well

- 

## What Went Poorly

- 

## Mitigations Applied During Incident

- 

## Corrective and Preventive Actions (CAPA)

| Action | Type (Corrective/Preventive) | Owner | Priority | Due Date | Status |
| --- | --- | --- | --- | --- | --- |
| Example: tighten readiness timeout with test coverage | Preventive | @owner | P1 | YYYY-MM-DD | Open |

## Validation Plan

- How fixes will be validated in CI/local:
  - `npm run validate:prometheus`
  - `npm run verify:observability`
- Additional runtime checks:
  - 

## Communication

- Internal updates sent to:
- External communication required: Yes/No
- Follow-up communication date:

## Follow-up Notes

- Related PRs/commits:
- Related incidents:
- Runbook changes required:
