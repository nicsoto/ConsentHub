const express = require("express");
const crypto = require("crypto");
const path = require("path");
const env = require("../config/env");
const {
  requireDashboardSession,
  requireDashboardPermission,
  requireDashboardSiteAccess,
  hasPermission,
  hasSiteAccess,
} = require("../middleware/dashboardAuth");
const { ensureCsrfCookie, requireCsrf } = require("../middleware/csrf");
const { createRateLimit } = require("../middleware/rateLimit");
const {
  createApiCredential,
  getDashboardStats,
  getActionBreakdown,
  getCategoryBreakdown,
  getBillingMttrHours,
  getMonthlyUsageBySites,
  listOpenBillingAlerts,
  listRecentBillingIncidents,
  resolveBillingAlert,
  runBillingAlertEscalation,
  listRecentEvents,
  listShops,
  listApiCredentials,
  listAuditLogs,
  listAuditLogsPage,
  encodeAuditCursor,
  isValidAuditCursor,
  revokeApiCredential,
  updateShopRetentionDays,
  runRetentionCleanup,
  createAuditLog,
  upsertDashboardAccessPolicy,
  listDashboardAccessPolicies,
  deleteDashboardAccessPolicyByEmail,
  findApiCredentialById,
} = require("../data/store");
const { getPlanLimitsForBilling } = require("../services/planLimits");
const { getWorkerJobsStatus } = require("../services/workerJobStatus");

const router = express.Router();
router.use(ensureCsrfCookie);

const auditLogsRateLimit = createRateLimit({
  windowMs: env.auditLogsRateLimitWindowMs,
  max: env.auditLogsRateLimitMax,
  keyPrefix: "dashboard:audit-logs",
  keyResolver: (req) => {
    const actor = String(req.dashboardUser?.email || "").trim().toLowerCase();
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    return `${actor || "anon"}:${ip}`;
  },
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function buildFilterParams(query) {
  const site = String(query.site || "").trim();
  const days = toPositiveInt(query.days || 30, 30);
  const limit = Math.min(toPositiveInt(query.limit || 80, 80), 300);

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const to = new Date();

  return {
    site,
    days,
    limit,
    from,
    to,
  };
}

function buildIncidentExportParams(query) {
  const site = String(query.site || "").trim();
  const status = String(query.status || "").trim();
  const days = Math.min(toPositiveInt(query.days || 30, 30), 365);
  const limit = Math.min(toPositiveInt(query.limit || 500, 500), 1000);
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const to = new Date();

  return {
    site,
    status,
    days,
    limit,
    from,
    to,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function pct(part, total) {
  if (!total) {
    return "0.0";
  }
  return ((part / total) * 100).toFixed(1);
}

function maskKey(value) {
  const key = String(value || "");
  if (key.length <= 8) {
    return "****";
  }
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function credentialDisplayLabel(credential) {
  const fingerprint = String(credential?.keyFingerprint || "").trim();
  if (fingerprint) {
    return fingerprint;
  }
  return maskKey(credential?.key);
}

function profileToScopes(profile) {
  const normalized = String(profile || "ingest").trim().toLowerCase();
  if (normalized === "read_export") {
    return ["read", "export"];
  }
  if (normalized === "full") {
    return ["ingest", "read", "export", "shops"];
  }
  return ["ingest"];
}

function isIngestOnlyScopes(scopes = []) {
  const normalized = (Array.isArray(scopes) ? scopes : [])
    .map((scope) => String(scope || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();

  return normalized.length === 1 && normalized[0] === "ingest";
}

function generateApiKey(profile) {
  const normalized = String(profile || "ingest").trim().toLowerCase();
  const prefix = normalized === "ingest" ? "ch_ing" : "ch_api";
  return `${prefix}_${crypto.randomBytes(20).toString("hex")}`;
}

async function auditDashboardAction(req, action, site = "", metadata = {}) {
  const actorEmail = String(req.dashboardUser?.email || "").trim().toLowerCase();
  if (!actorEmail || !action) {
    return;
  }

  try {
    await createAuditLog({
      actorEmail,
      action,
      site,
      requestId: req.requestId,
      metadata,
    });
  } catch (error) {
    console.error(error);
  }
}

function parseWorkerJobAction(actionValue) {
  const action = String(actionValue || "").trim().toLowerCase();
  const match = action.match(/^worker\.job\.([a-z_]+)\.(success|error)$/);
  if (!match) {
    return null;
  }
  return {
    job: match[1],
    status: match[2],
  };
}

async function listWorkerJobsHistoryPage({ normalizedJob, status, limit, cursor }) {
  const statuses = status ? [status] : ["success", "error"];
  const jobs = normalizedJob ? [normalizedJob] : ["retention", "billing_alerts"];

  const matchesWorkerAction = (actionValue) => {
    const parsed = parseWorkerJobAction(actionValue);
    if (!parsed) {
      return false;
    }
    return jobs.includes(parsed.job) && statuses.includes(parsed.status);
  };

  const history = [];
  let nextCursor = "";
  let scanCursor = cursor;
  const scanLimit = Math.min(Math.max(limit * 4, 40), 500);

  for (let iteration = 0; iteration < 25; iteration += 1) {
    const page = await listAuditLogsPage({
      actorEmail: "system@worker.local",
      limit: scanLimit,
      cursor: scanCursor,
    });

    for (const row of page.rows) {
      if (!matchesWorkerAction(row.action)) {
        continue;
      }

      history.push(row);
      if (history.length >= limit) {
        nextCursor = encodeAuditCursor(row);
        return { history, nextCursor };
      }
    }

    if (!page.nextCursor) {
      nextCursor = "";
      break;
    }

    scanCursor = page.nextCursor;
    nextCursor = page.nextCursor;
  }

  return { history, nextCursor };
}

async function loadDashboardSnapshot(filters) {
  const [stats, actions, categories, shops, recentEvents, billingAlerts, incidents, mttr, apiCredentials] = await Promise.all([
    getDashboardStats(filters),
    getActionBreakdown(filters),
    getCategoryBreakdown(filters),
    listShops(),
    listRecentEvents(filters),
    listOpenBillingAlerts(20),
    listRecentBillingIncidents(20),
    getBillingMttrHours(30),
    listApiCredentials({ status: "active", limit: 400 }),
  ]);

  const credentialsBySite = apiCredentials.reduce((acc, cred) => {
    const key = String(cred.site || "").trim();
    if (!key) {
      return acc;
    }
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(cred);
    return acc;
  }, {});

  const sites = shops.map((shop) => String(shop.site || "").trim().toLowerCase()).filter(Boolean);
  const usageBySite = await getMonthlyUsageBySites(sites, 30);
  const shopsWithUsage = shops.map((shop) => ({
    ...shop,
    usageLast30Days: Number(usageBySite[String(shop.site || "").trim().toLowerCase()] || 0),
  }));

  const atRiskCount = shopsWithUsage.filter((shop) => {
    if (shop.billingStatus !== "past_due") {
      return false;
    }
    if (!shop.gracePeriodEndsAt) {
      return false;
    }
    const graceDate = new Date(shop.gracePeriodEndsAt);
    return !Number.isNaN(graceDate.getTime()) && graceDate > new Date();
  }).length;

  return {
    stats,
    actions,
    categories,
    shopsWithUsage,
    credentialsBySite,
    atRiskCount,
    billingAlerts,
    incidents,
    mttr,
    recentEvents,
  };
}

function renderDashboard(
  stats,
  actions,
  categories,
  shops,
  credentialsBySite,
  atRiskCount,
  billingAlerts,
  incidents,
  mttr,
  recentEvents,
  userEmail,
  csrfToken,
  filters,
  flash = ""
) {
  const total = stats.eventsCount;
  const acceptCount = Number(actions.accept_all || 0);
  const rejectCount = Number(actions.reject_non_essential || 0);
  const customCount = Number(actions.custom_preferences || 0);

  const categoryRows = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([category, count]) => `<tr>
        <td>${escapeHtml(category)}</td>
        <td>${count}</td>
        <td>${pct(count, total)}%</td>
      </tr>`
    )
    .join("");

  const shopsRows = shops
    .map(
      (shop) => {
        const { effectivePlan, limits } = getPlanLimitsForBilling(shop);
        const usage = shop.usageLast30Days ?? 0;
        const usagePct = limits.monthlyEvents ? Math.min(100, (usage / limits.monthlyEvents) * 100) : 0;
        const graceInfo =
          shop.billingStatus === "past_due" && shop.gracePeriodEndsAt
            ? `<div class="muted" style="margin-top:4px;">Gracia hasta: ${new Date(shop.gracePeriodEndsAt).toLocaleDateString("es-CL")}</div>`
            : "";
        const credentials = credentialsBySite[shop.site] || [];
        const credentialsHtml = credentials.length
          ? credentials
            .map(
              (credential) => `<div class="muted" style="margin-top:6px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <span>${escapeHtml(credentialDisplayLabel(credential))}</span>
                  <span>Scopes: ${escapeHtml((credential.scopes || []).join(","))}</span>
                  <form method="post" action="/dashboard/api-credentials/${escapeHtml(credential.id)}/revoke" style="display:inline;">
                    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
                    <button class="logout" type="submit">Revocar</button>
                  </form>
                </div>`
            )
            .join("")
          : `<div class="muted" style="margin-top:6px;">Sin credenciales activas</div>`;

        return `<tr>
        <td>${escapeHtml(shop.site)}</td>
        <td>${escapeHtml(shop.country)}</td>
        <td>${shop.retentionDays} dias</td>
        <td>${escapeHtml(shop.plan || "free")}</td>
        <td>${escapeHtml(shop.billingStatus || "free")}</td>
        <td>
          ${usage}/${limits.monthlyEvents}
          <div class="muted" style="margin-top:4px;">Plan efectivo: ${escapeHtml(effectivePlan)}</div>
          ${graceInfo}
          <div style="margin-top:4px; height:6px; background:#1f2937; border-radius:999px; overflow:hidden;">
            <div style="width:${usagePct.toFixed(1)}%; height:6px; background:${usagePct >= 95 ? "#ef4444" : "#22c55e"};"></div>
          </div>
        </td>
        <td>${new Date(shop.createdAt).toLocaleString("es-CL")}</td>
        <td>
          <form method="post" action="/dashboard/retention" style="display:flex; gap:6px; align-items:center;">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
            <input type="hidden" name="site" value="${escapeHtml(shop.site)}" />
            <input type="number" min="1" max="3650" name="retentionDays" value="${shop.retentionDays}" style="width:84px; background:#0b1220; color:#e2e8f0; border:1px solid #334155; border-radius:6px; padding:4px 6px;" />
            <button class="logout" type="submit">Guardar</button>
          </form>
          <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
            <form method="post" action="/billing/checkout">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="site" value="${escapeHtml(shop.site)}" />
              <input type="hidden" name="plan" value="starter" />
              <button class="logout" type="submit">Checkout Starter</button>
            </form>
            <form method="post" action="/billing/checkout">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="site" value="${escapeHtml(shop.site)}" />
              <input type="hidden" name="plan" value="pro" />
              <button class="logout" type="submit">Checkout Pro</button>
            </form>
            <form method="post" action="/billing/mock-upgrade">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="site" value="${escapeHtml(shop.site)}" />
              <input type="hidden" name="plan" value="starter" />
              <button class="logout" type="submit">Mock Starter (dev)</button>
            </form>
            <form method="post" action="/billing/portal">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="site" value="${escapeHtml(shop.site)}" />
              <button class="logout" type="submit">Portal cliente</button>
            </form>
          </div>
          <div style="margin-top:8px; border-top:1px solid #223046; padding-top:8px;">
            <div class="muted">Credenciales API</div>
            <form method="post" action="/dashboard/api-credentials/create" style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:6px;">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="site" value="${escapeHtml(shop.site)}" />
              <select name="profile" style="background:#0b1220; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:6px 8px;">
                <option value="ingest">Ingesta (plugin)</option>
                <option value="read_export">Lectura + Export</option>
                <option value="full">Full Admin API</option>
              </select>
              <button class="logout" type="submit">Generar key</button>
            </form>
            ${credentialsHtml}
            <form method="post" action="/dashboard/api-credentials/regenerate-ingest" style="margin-top:8px;">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
              <input type="hidden" name="site" value="${escapeHtml(shop.site)}" />
              <button class="logout" type="submit">Regenerar key Ingest</button>
            </form>
          </div>
        </td>
      </tr>`;
      }
    )
    .join("");

  const eventsRows = recentEvents
    .map(
      (event) => `<tr>
        <td>${new Date(event.timestamp).toLocaleString("es-CL")}</td>
        <td>${escapeHtml(event.site)}</td>
        <td>${escapeHtml(event.category)}</td>
        <td>${escapeHtml(event.action)}</td>
        <td>${escapeHtml(event.country)}</td>
      </tr>`
    )
    .join("");

  const alertsRows = billingAlerts
    .map(
      (alert) => `<tr>
        <td>${new Date(alert.createdAt).toLocaleString("es-CL")}</td>
        <td>${escapeHtml(alert.site)}</td>
        <td>${escapeHtml(alert.type)}</td>
        <td>${escapeHtml(alert.severity)}</td>
        <td>${escapeHtml(alert.message)}</td>
        <td>
          <form method="post" action="/dashboard/billing-alerts/${escapeHtml(alert.id)}/resolve">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
            <button class="logout" type="submit">Marcar resuelta</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  const incidentsRows = incidents
    .map(
      (incident) => `<tr>
        <td>${new Date(incident.createdAt).toLocaleString("es-CL")}</td>
        <td>${escapeHtml(incident.site)}</td>
        <td>${escapeHtml(incident.type)}</td>
        <td>${escapeHtml(incident.status)}</td>
        <td>${escapeHtml(incident.severity)}</td>
        <td>${incident.resolvedAt ? new Date(incident.resolvedAt).toLocaleString("es-CL") : "-"}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ConsentHub Dashboard</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #0b1120; color: #e2e8f0; }
      .container { width: min(1100px, 95vw); margin: 24px auto; }
      .stats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 16px; }
      .card { background: #111827; border: 1px solid #334155; border-radius: 10px; padding: 14px; }
      .label { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
      .value { font-size: 28px; font-weight: 700; margin-top: 6px; }
      h1 { margin: 0 0 16px; }
      .table-wrap { background: #111827; border: 1px solid #334155; border-radius: 10px; padding: 10px; overflow-x: auto; margin-bottom: 16px; }
      table { width: 100%; border-collapse: collapse; min-width: 720px; }
      th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #223046; font-size: 14px; }
      th { color: #93c5fd; font-weight: 600; }
      .topbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
      .muted { color: #94a3b8; font-size: 13px; }
      a { color: #60a5fa; text-decoration: none; }
      .logout { background: #1f2937; color: #f9fafb; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
      .actions { display: flex; align-items: center; gap: 10px; }
      .filters { background: #111827; border: 1px solid #334155; border-radius: 10px; padding: 12px; margin-bottom: 16px; }
      .filters form { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
      .filters label { display: grid; gap: 4px; color: #94a3b8; font-size: 12px; }
      .filters input, .filters select { background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px 10px; }
      .flash { margin-bottom: 10px; padding: 10px; border-radius: 8px; background: #072b1a; border: 1px solid #14532d; color: #86efac; }
      .kpi { font-size: 14px; color: #cbd5e1; margin-top: 6px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="topbar">
        <h1>ConsentHub Dashboard</h1>
        <div class="actions">
          <span class="muted">Sesion: ${escapeHtml(userEmail)}</span>
          <a href="/dashboard-v2">Dashboard V2</a>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
            <button class="logout" type="submit">Cerrar sesion</button>
          </form>
        </div>
      </div>

      ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}

      <section class="filters">
        <form method="get" action="/dashboard">
          <label>
            Sitio
            <input type="text" name="site" placeholder="ej: demo.local" value="${escapeHtml(filters.site)}" />
          </label>
          <label>
            Ultimos dias
            <select name="days">
              <option value="1" ${filters.days === 1 ? "selected" : ""}>1</option>
              <option value="7" ${filters.days === 7 ? "selected" : ""}>7</option>
              <option value="30" ${filters.days === 30 ? "selected" : ""}>30</option>
              <option value="90" ${filters.days === 90 ? "selected" : ""}>90</option>
            </select>
          </label>
          <label>
            Limite
            <input type="number" min="1" max="300" name="limit" value="${filters.limit}" />
          </label>
          <button class="logout" type="submit">Aplicar filtros</button>
        </form>
      </section>

      <section class="stats">
        <article class="card">
          <div class="label">Sitios conectados</div>
          <div class="value">${stats.shopsCount}</div>
        </article>
        <article class="card">
          <div class="label">Eventos (filtro actual)</div>
          <div class="value">${stats.eventsCount}</div>
        </article>
        <article class="card">
          <div class="label">Aceptar todo</div>
          <div class="value">${acceptCount}</div>
          <div class="kpi">${pct(acceptCount, total)}%</div>
        </article>
        <article class="card">
          <div class="label">Rechazar no esenciales</div>
          <div class="value">${rejectCount}</div>
          <div class="kpi">${pct(rejectCount, total)}%</div>
        </article>
        <article class="card">
          <div class="label">Personalizar</div>
          <div class="value">${customCount}</div>
          <div class="kpi">${pct(customCount, total)}%</div>
        </article>
        <article class="card">
          <div class="label">Sitios en riesgo</div>
          <div class="value">${atRiskCount}</div>
          <div class="kpi">past_due con gracia activa</div>
        </article>
      </section>

      <section class="table-wrap">
        <h2>Desglose por categoria</h2>
        <table>
          <thead>
            <tr>
              <th>Categoria</th>
              <th>Eventos</th>
              <th>% del total</th>
            </tr>
          </thead>
          <tbody>
            ${categoryRows || `<tr><td colspan="3" class="muted">Sin datos de categorias para el filtro actual.</td></tr>`}
          </tbody>
        </table>
      </section>

      <section class="table-wrap">
        <h2>Sitios</h2>
        <table>
          <thead>
            <tr>
              <th>Sitio</th>
              <th>Pais</th>
              <th>Retencion</th>
              <th>Plan</th>
              <th>Estado cobro</th>
              <th>Uso 30 dias</th>
              <th>Alta</th>
              <th>Accion</th>
            </tr>
          </thead>
          <tbody>
            ${shopsRows || `<tr><td colspan="8" class="muted">Sin sitios registrados todavia.</td></tr>`}
          </tbody>
        </table>
      </section>

      <section class="table-wrap">
        <h2>Alertas de facturacion</h2>
        <form method="post" action="/dashboard/billing-alerts/escalate" style="margin-bottom:10px;">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <button class="logout" type="submit">Revisar alertas vencidas</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Sitio</th>
              <th>Tipo</th>
              <th>Severidad</th>
              <th>Detalle</th>
              <th>Accion</th>
            </tr>
          </thead>
          <tbody>
            ${alertsRows || `<tr><td colspan="6" class="muted">Sin alertas abiertas.</td></tr>`}
          </tbody>
        </table>
      </section>

      <section class="table-wrap">
        <h2>Incidentes recientes</h2>
        <p class="muted">MTTR 30 dias: ${mttr.mttrHours}h (${mttr.resolvedCount} resueltos)</p>
        <p class="muted" style="margin-top:4px;">Exportar: <a href="/dashboard/incidents/export.csv?days=30&limit=500">CSV (30 dias)</a> · <a href="/dashboard/incidents/export?days=30&limit=500">JSON (30 dias)</a></p>
        <table>
          <thead>
            <tr>
              <th>Creado</th>
              <th>Sitio</th>
              <th>Tipo</th>
              <th>Estado</th>
              <th>Severidad</th>
              <th>Resuelto</th>
            </tr>
          </thead>
          <tbody>
            ${incidentsRows || `<tr><td colspan="6" class="muted">Sin incidentes recientes.</td></tr>`}
          </tbody>
        </table>
      </section>

      <section class="table-wrap">
        <h2>Ultimos eventos</h2>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Sitio</th>
              <th>Categoria</th>
              <th>Accion</th>
              <th>Pais</th>
            </tr>
          </thead>
          <tbody>
            ${eventsRows || `<tr><td colspan="5" class="muted">Sin eventos registrados todavia.</td></tr>`}
          </tbody>
        </table>
      </section>

      <p class="muted">Tip: exporta por sitio con API key en header x-api-key desde scripts o integraciones.</p>
      <form method="post" action="/dashboard/retention/run" style="margin-top:10px;">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
        <button class="logout" type="submit">Ejecutar limpieza de retencion ahora</button>
      </form>
    </div>
  </body>
</html>`;
}

router.get("/dashboard", requireDashboardSession, requireDashboardPermission("dashboard.view"), async (req, res) => {
  const flash = String(req.query?.flash || "").trim();
  const target = flash ? `/dashboard-v2?flash=${encodeURIComponent(flash)}` : "/dashboard-v2";
  return res.redirect(target);
});

router.get("/dashboard-v2", requireDashboardSession, requireDashboardPermission("dashboard.view"), async (_req, res) => {
  return res
    .status(200)
    .sendFile(path.join(__dirname, "..", "public", "dashboard-v2", "index.html"));
});

router.get("/dashboard-v2/assets/:asset", requireDashboardSession, requireDashboardPermission("dashboard.view"), async (req, res) => {
  const asset = String(req.params?.asset || "").trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(asset)) {
    return res.status(400).send("Asset invalido");
  }

  return res
    .status(200)
    .sendFile(path.join(__dirname, "..", "public", "dashboard-v2", "assets", asset));
});

router.get("/dashboard-v2/data", requireDashboardSession, requireDashboardPermission("dashboard.view"), async (req, res) => {
  const filters = buildFilterParams(req.query || {});

  try {
    const snapshot = await loadDashboardSnapshot(filters);
    const topCategories = Object.entries(snapshot.categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([category, count]) => ({ category, count }));

    const topShops = snapshot.shopsWithUsage
      .sort((a, b) => Number(b.usageLast30Days || 0) - Number(a.usageLast30Days || 0))
      .slice(0, 12)
      .map((shop) => ({
        site: shop.site,
        billingStatus: shop.billingStatus,
        plan: shop.plan,
        retentionDays: shop.retentionDays,
        usageLast30Days: shop.usageLast30Days,
      }));

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      csrfToken: req.csrfToken,
      user: {
        email: req.dashboardUser.email,
        canManageAccess: hasPermission(req.dashboardUser, "dashboard.access.manage"),
      },
      filters: {
        site: filters.site,
        days: filters.days,
        limit: filters.limit,
      },
      summary: {
        eventsCount: snapshot.stats.eventsCount,
        acceptsRate: snapshot.stats.acceptsRate,
        atRiskCount: snapshot.atRiskCount,
        openBillingAlerts: snapshot.billingAlerts.filter((alert) => hasSiteAccess(req.dashboardUser, alert.site)).length,
        openIncidents: snapshot.incidents
          .filter((incident) => incident.status === "open")
          .filter((incident) => hasSiteAccess(req.dashboardUser, incident.site)).length,
        mttrHours30d: snapshot.mttr,
      },
      actions: snapshot.actions,
      shops: snapshot.shopsWithUsage
        .filter((shop) => hasSiteAccess(req.dashboardUser, shop.site))
        .map((shop) => ({
          site: shop.site,
          plan: shop.plan,
          billingStatus: shop.billingStatus,
          retentionDays: shop.retentionDays,
          usageLast30Days: shop.usageLast30Days,
        })),
      billingAlerts: snapshot.billingAlerts
        .filter((alert) => hasSiteAccess(req.dashboardUser, alert.site))
        .map((alert) => ({
          id: alert.id,
          site: alert.site,
          status: alert.status,
          severity: alert.severity,
          message: alert.message,
          createdAt: alert.createdAt,
        })),
      apiCredentials: Object.entries(snapshot.credentialsBySite).flatMap(([site, credentials]) =>
        credentials.map((cred) => ({
          id: cred.id,
          site,
          status: cred.status,
          scopes: cred.scopes,
          createdAt: cred.createdAt,
          lastUsedAt: cred.lastUsedAt,
        }))
      ).filter((cred) => hasSiteAccess(req.dashboardUser, cred.site)),
      topCategories,
      topShops: topShops.filter((shop) => hasSiteAccess(req.dashboardUser, shop.site)),
      recentEvents: snapshot.recentEvents.slice(0, 20).filter((event) => hasSiteAccess(req.dashboardUser, event.site)),
      accessPolicies: hasPermission(req.dashboardUser, "dashboard.access.manage")
        ? (await listDashboardAccessPolicies({ status: "active", limit: 500 })).map((row) => ({
            email: row.email,
            role: row.role,
            sites: row.sites,
            status: row.status,
            updatedAt: row.updatedAt,
          }))
        : [],
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No fue posible cargar dashboard-v2" });
  }
});

router.get(
  "/dashboard-v2/access-policies",
  requireDashboardSession,
  requireDashboardPermission("dashboard.access.manage"),
  async (_req, res) => {
    try {
      const rows = await listDashboardAccessPolicies({ status: "active", limit: 1000 });
      return res.status(200).json({
        total: rows.length,
        policies: rows.map((row) => ({
          email: row.email,
          role: row.role,
          sites: row.sites,
          status: row.status,
          updatedAt: row.updatedAt,
        })),
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "No se pudo listar politicas" });
    }
  }
);

router.post(
  "/dashboard-v2/access-policies/upsert",
  requireDashboardSession,
  requireDashboardPermission("dashboard.access.manage"),
  requireCsrf,
  async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "admin").trim().toLowerCase();
    const sites = Array.isArray(req.body?.sites)
      ? req.body.sites
      : String(req.body?.sites || "")
          .split(",")
          .map((site) => site.trim().toLowerCase())
          .filter(Boolean);

    if (!email) {
      return res.status(400).json({ error: "Email invalido" });
    }

    try {
      const saved = await upsertDashboardAccessPolicy({
        email,
        role,
        sites,
        status: "active",
      });
      await auditDashboardAction(req, "dashboard.access_policy.upsert", "", {
        email,
        role: saved.role,
        sites: saved.sites,
      });
      return res.status(200).json({ ok: true, policy: saved });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "No se pudo guardar politica" });
    }
  }
);

router.post(
  "/dashboard-v2/access-policies/delete",
  requireDashboardSession,
  requireDashboardPermission("dashboard.access.manage"),
  requireCsrf,
  async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Email invalido" });
    }

    try {
      const result = await deleteDashboardAccessPolicyByEmail(email);
      await auditDashboardAction(req, "dashboard.access_policy.delete", "", { email, deleted: result.deleted });
      return res.status(200).json({ ok: true, deleted: result.deleted });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "No se pudo eliminar politica" });
    }
  }
);

router.post(
  "/dashboard-v2/retention",
  requireDashboardSession,
  requireDashboardPermission("dashboard.retention.write"),
  requireDashboardSiteAccess((req) => req.body?.site),
  requireCsrf,
  async (req, res) => {
  const site = String(req.body?.site || "").trim();
  const retentionDays = toPositiveInt(req.body?.retentionDays || 0, 0);

  if (!site || retentionDays < 1 || retentionDays > 3650) {
    return res.status(400).json({ error: "Retencion invalida" });
  }

  try {
    await updateShopRetentionDays(site, retentionDays);
    await auditDashboardAction(req, "dashboard.retention.update", site, { retentionDays, source: "dashboard-v2" });
    return res.status(200).json({ ok: true, message: `Retencion actualizada para ${site}` });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo actualizar retencion" });
  }
  }
);

router.post(
  "/dashboard-v2/retention/run",
  requireDashboardSession,
  requireDashboardPermission("dashboard.retention.write"),
  requireCsrf,
  async (req, res) => {
  try {
    const result = await runRetentionCleanup();
    await auditDashboardAction(req, "dashboard.retention.cleanup.run", "", {
      deletedTotal: result.deletedTotal,
      sitesAffected: Array.isArray(result.bySite) ? result.bySite.length : 0,
      source: "dashboard-v2",
    });
    return res.status(200).json({
      ok: true,
      message: `Limpieza ejecutada. Eliminados: ${result.deletedTotal}`,
      result,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fallo la limpieza de retencion" });
  }
  }
);

router.post(
  "/dashboard-v2/billing-alerts/:id/resolve",
  requireDashboardSession,
  requireDashboardPermission("dashboard.billing_alerts.write"),
  requireCsrf,
  async (req, res) => {
  const alertId = String(req.params?.id || "").trim();

  if (!alertId) {
    return res.status(400).json({ error: "Alerta invalida" });
  }

  try {
    const openAlerts = await listOpenBillingAlerts(200);
    const target = openAlerts.find((alert) => String(alert.id || "") === alertId);
    if (!target || !hasSiteAccess(req.dashboardUser, target.site)) {
      return res.status(403).json({ error: "Sin acceso a la alerta" });
    }

    await resolveBillingAlert(alertId);
    await auditDashboardAction(req, "dashboard.billing_alert.resolve", "", { alertId, source: "dashboard-v2" });
    return res.status(200).json({ ok: true, message: "Alerta marcada como resuelta" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo resolver la alerta" });
  }
  }
);

router.post(
  "/dashboard-v2/billing-alerts/escalate",
  requireDashboardSession,
  requireDashboardPermission("dashboard.billing_alerts.write"),
  requireCsrf,
  async (req, res) => {
  try {
    const result = await runBillingAlertEscalation();
    await auditDashboardAction(req, "dashboard.billing_alert.escalate", "", {
      escalatedCount: result.escalatedCount,
      source: "dashboard-v2",
    });
    return res.status(200).json({
      ok: true,
      message: `Alertas escaladas: ${result.escalatedCount}`,
      result,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo ejecutar la revision de alertas" });
  }
  }
);

router.post(
  "/dashboard-v2/api-credentials/create",
  requireDashboardSession,
  requireDashboardPermission("dashboard.credentials.write"),
  requireDashboardSiteAccess((req) => req.body?.site),
  requireCsrf,
  async (req, res) => {
  const site = String(req.body?.site || "").trim().toLowerCase();
  const profile = String(req.body?.profile || "ingest").trim().toLowerCase();
  const scopes = profileToScopes(profile);

  if (!site) {
    return res.status(400).json({ error: "Sitio invalido para credencial" });
  }

  try {
    const key = generateApiKey(profile);
    await createApiCredential({ key, site, scopes, status: "active" });
    await auditDashboardAction(req, "dashboard.api_credential.create", site, {
      profile,
      scopes,
      source: "dashboard-v2",
    });
    return res.status(200).json({
      ok: true,
      message: "Credencial creada",
      credential: {
        site,
        profile,
        scopes,
        key,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo crear la credencial" });
  }
  }
);

router.post(
  "/dashboard-v2/api-credentials/:id/revoke",
  requireDashboardSession,
  requireDashboardPermission("dashboard.credentials.write"),
  requireCsrf,
  async (req, res) => {
  const credentialId = String(req.params?.id || "").trim();

  if (!credentialId) {
    return res.status(400).json({ error: "Credencial invalida" });
  }

  try {
    const target = await findApiCredentialById(credentialId);
    if (!target || !hasSiteAccess(req.dashboardUser, target.site)) {
      return res.status(403).json({ error: "Sin acceso a la credencial" });
    }

    await revokeApiCredential(credentialId);
    await auditDashboardAction(req, "dashboard.api_credential.revoke", "", {
      credentialId,
      source: "dashboard-v2",
    });
    return res.status(200).json({ ok: true, message: "Credencial revocada" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo revocar la credencial" });
  }
  }
);

router.post(
  "/dashboard-v2/api-credentials/regenerate-ingest",
  requireDashboardSession,
  requireDashboardPermission("dashboard.credentials.write"),
  requireDashboardSiteAccess((req) => req.body?.site),
  requireCsrf,
  async (req, res) => {
  const site = String(req.body?.site || "").trim().toLowerCase();
  if (!site) {
    return res.status(400).json({ error: "Sitio invalido para regenerar key" });
  }

  try {
    const active = await listApiCredentials({ site, status: "active", limit: 200 });
    const ingestOnly = active.filter((cred) => isIngestOnlyScopes(cred.scopes));

    for (const cred of ingestOnly) {
      await revokeApiCredential(cred.id);
    }

    const key = generateApiKey("ingest");
    await createApiCredential({ key, site, scopes: ["ingest"], status: "active" });
    await auditDashboardAction(req, "dashboard.api_credential.regenerate_ingest", site, {
      revokedIngestCount: ingestOnly.length,
      source: "dashboard-v2",
    });

    return res.status(200).json({
      ok: true,
      message: "Key ingest regenerada",
      credential: {
        site,
        scopes: ["ingest"],
        key,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo regenerar la key ingest" });
  }
  }
);

router.post("/dashboard/retention", requireDashboardSession, requireCsrf, async (req, res) => {
  return res.redirect("/dashboard-v2?flash=Dashboard+legacy+deprecado.+Usa+Dashboard+V2");

  const site = String(req.body?.site || "").trim();
  const retentionDays = toPositiveInt(req.body?.retentionDays || 0, 0);

  if (!hasPermission(req.dashboardUser, "dashboard.retention.write")) {
    return res.redirect("/dashboard?flash=No+tienes+permiso+para+retencion");
  }

  if (!hasSiteAccess(req.dashboardUser, site)) {
    return res.redirect("/dashboard?flash=Sin+acceso+al+sitio");
  }

  if (!site || retentionDays < 1 || retentionDays > 3650) {
    return res.redirect("/dashboard?flash=Retencion+invalida");
  }

  try {
    await updateShopRetentionDays(site, retentionDays);
    await auditDashboardAction(req, "dashboard.retention.update", site, { retentionDays });
    return res.redirect(`/dashboard?flash=Retencion+actualizada+para+${encodeURIComponent(site)}`);
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard?flash=No+se+pudo+actualizar+retencion");
  }
});

router.post("/dashboard/retention/run", requireDashboardSession, requireCsrf, async (req, res) => {
  return res.redirect("/dashboard-v2?flash=Dashboard+legacy+deprecado.+Usa+Dashboard+V2");

  if (!hasPermission(req.dashboardUser, "dashboard.retention.write")) {
    return res.redirect("/dashboard?flash=No+tienes+permiso+para+retencion");
  }

  try {
    const result = await runRetentionCleanup();
    await auditDashboardAction(req, "dashboard.retention.cleanup.run", "", {
      deletedTotal: result.deletedTotal,
      sitesAffected: Array.isArray(result.bySite) ? result.bySite.length : 0,
    });
    return res.redirect(`/dashboard?flash=Limpieza+ejecutada.+Eliminados:+${result.deletedTotal}`);
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard?flash=Fallo+la+limpieza+de+retencion");
  }
});

router.post("/dashboard/billing-alerts/:id/resolve", requireDashboardSession, requireCsrf, async (req, res) => {
  return res.redirect("/dashboard-v2?flash=Dashboard+legacy+deprecado.+Usa+Dashboard+V2");

  const alertId = String(req.params?.id || "").trim();

  if (!hasPermission(req.dashboardUser, "dashboard.billing_alerts.write")) {
    return res.redirect("/dashboard?flash=No+tienes+permiso+para+billing");
  }

  if (!alertId) {
    return res.redirect("/dashboard?flash=Alerta+invalida");
  }

  try {
    const openAlerts = await listOpenBillingAlerts(200);
    const target = openAlerts.find((alert) => String(alert.id || "") === alertId);
    if (!target || !hasSiteAccess(req.dashboardUser, target.site)) {
      return res.redirect("/dashboard?flash=Sin+acceso+a+la+alerta");
    }

    await resolveBillingAlert(alertId);
    await auditDashboardAction(req, "dashboard.billing_alert.resolve", "", { alertId });
    return res.redirect("/dashboard?flash=Alerta+marcada+como+resuelta");
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard?flash=No+se+pudo+resolver+la+alerta");
  }
});

router.post("/dashboard/billing-alerts/escalate", requireDashboardSession, requireCsrf, async (req, res) => {
  return res.redirect("/dashboard-v2?flash=Dashboard+legacy+deprecado.+Usa+Dashboard+V2");

  if (!hasPermission(req.dashboardUser, "dashboard.billing_alerts.write")) {
    return res.redirect("/dashboard?flash=No+tienes+permiso+para+billing");
  }

  try {
    const result = await runBillingAlertEscalation();
    await auditDashboardAction(req, "dashboard.billing_alert.escalate", "", {
      escalatedCount: result.escalatedCount,
    });
    return res.redirect(`/dashboard?flash=Alertas+escaladas:+${result.escalatedCount}`);
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard?flash=No+se+pudo+ejecutar+la+revision+de+alertas");
  }
});

router.post("/dashboard/api-credentials/create", requireDashboardSession, requireCsrf, async (req, res) => {
  return res.redirect("/dashboard-v2?flash=Dashboard+legacy+deprecado.+Usa+Dashboard+V2");

  const site = String(req.body?.site || "").trim().toLowerCase();
  const profile = String(req.body?.profile || "ingest").trim().toLowerCase();
  const scopes = profileToScopes(profile);

  if (!hasPermission(req.dashboardUser, "dashboard.credentials.write")) {
    return res.redirect("/dashboard?flash=No+tienes+permiso+para+credenciales");
  }

  if (!hasSiteAccess(req.dashboardUser, site)) {
    return res.redirect("/dashboard?flash=Sin+acceso+al+sitio");
  }

  if (!site) {
    return res.redirect("/dashboard?flash=Sitio+invalido+para+credencial");
  }

  try {
    const key = generateApiKey(profile);
    await createApiCredential({ key, site, scopes, status: "active" });
    await auditDashboardAction(req, "dashboard.api_credential.create", site, {
      profile,
      scopes,
    });
    return res.status(200).send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8" /><title>Credential creada</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 760px; margin: 24px auto; line-height: 1.5;">
    <h1>Credencial creada</h1>
    <p><strong>Sitio:</strong> ${escapeHtml(site)}</p>
    <p><strong>Scopes:</strong> ${escapeHtml(scopes.join(","))}</p>
    <p style="padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#f8fafc;"><strong>API Key:</strong> ${escapeHtml(key)}</p>
    <p>Guarda esta clave ahora. No se vuelve a mostrar completa en el dashboard.</p>
    <p><a href="/dashboard">Volver al dashboard</a></p>
  </body>
</html>`);
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard?flash=No+se+pudo+crear+la+credencial");
  }
});

router.post("/dashboard/api-credentials/:id/revoke", requireDashboardSession, requireCsrf, async (req, res) => {
  return res.redirect("/dashboard-v2?flash=Dashboard+legacy+deprecado.+Usa+Dashboard+V2");

  const credentialId = String(req.params?.id || "").trim();

  if (!hasPermission(req.dashboardUser, "dashboard.credentials.write")) {
    return res.redirect("/dashboard?flash=No+tienes+permiso+para+credenciales");
  }

  if (!credentialId) {
    return res.redirect("/dashboard?flash=Credencial+invalida");
  }

  try {
    const target = await findApiCredentialById(credentialId);
    if (!target || !hasSiteAccess(req.dashboardUser, target.site)) {
      return res.redirect("/dashboard?flash=Sin+acceso+a+la+credencial");
    }

    await revokeApiCredential(credentialId);
    await auditDashboardAction(req, "dashboard.api_credential.revoke", "", { credentialId });
    return res.redirect("/dashboard?flash=Credencial+revocada");
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard?flash=No+se+pudo+revocar+la+credencial");
  }
});

router.post("/dashboard/api-credentials/regenerate-ingest", requireDashboardSession, requireCsrf, async (req, res) => {
  return res.redirect("/dashboard-v2?flash=Dashboard+legacy+deprecado.+Usa+Dashboard+V2");

  const site = String(req.body?.site || "").trim().toLowerCase();

  if (!hasPermission(req.dashboardUser, "dashboard.credentials.write")) {
    return res.redirect("/dashboard?flash=No+tienes+permiso+para+credenciales");
  }

  if (!hasSiteAccess(req.dashboardUser, site)) {
    return res.redirect("/dashboard?flash=Sin+acceso+al+sitio");
  }

  if (!site) {
    return res.redirect("/dashboard?flash=Sitio+invalido+para+regenerar+key");
  }

  try {
    const active = await listApiCredentials({ site, status: "active", limit: 200 });
    const ingestOnly = active.filter((cred) => isIngestOnlyScopes(cred.scopes));

    for (const cred of ingestOnly) {
      await revokeApiCredential(cred.id);
    }

    const key = generateApiKey("ingest");
    await createApiCredential({ key, site, scopes: ["ingest"], status: "active" });
    await auditDashboardAction(req, "dashboard.api_credential.regenerate_ingest", site, {
      revokedIngestCount: ingestOnly.length,
    });

    return res.status(200).send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8" /><title>Key Ingest regenerada</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 760px; margin: 24px auto; line-height: 1.5;">
    <h1>Key Ingest regenerada</h1>
    <p><strong>Sitio:</strong> ${escapeHtml(site)}</p>
    <p><strong>Credenciales ingest revocadas:</strong> ${ingestOnly.length}</p>
    <p style="padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#f8fafc;"><strong>Nueva API Key:</strong> ${escapeHtml(key)}</p>
    <p>Actualiza esta key en tu plugin WordPress para continuar enviando eventos.</p>
    <p><a href="/dashboard">Volver al dashboard</a></p>
  </body>
</html>`);
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard?flash=No+se+pudo+regenerar+la+key+ingest");
  }
});

router.get(
  "/dashboard/audit-logs",
  requireDashboardSession,
  requireDashboardPermission("dashboard.audit.read"),
  auditLogsRateLimit,
  async (req, res) => {
  const site = String(req.query?.site || "").trim().toLowerCase();
  const action = String(req.query?.action || "").trim().toLowerCase();
  const actorEmail = String(req.query?.actorEmail || "").trim().toLowerCase();
  const limit = Math.min(toPositiveInt(req.query?.limit || 100, 100), 500);
  const cursor = String(req.query?.cursor || "").trim();

  if (cursor && !isValidAuditCursor(cursor)) {
    return res.status(400).json({ error: "Cursor de auditoria invalido" });
  }

  try {
    const page = await listAuditLogsPage({ site, action, actorEmail, limit, cursor });
    return res.status(200).json({
      total: page.rows.length,
      filters: { site, action, actorEmail, limit },
      nextCursor: page.nextCursor || "",
      logs: page.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo consultar auditoria" });
  }
  }
);

router.get(
  "/dashboard/audit-logs.csv",
  requireDashboardSession,
  requireDashboardPermission("dashboard.audit.read"),
  auditLogsRateLimit,
  async (req, res) => {
  const site = String(req.query?.site || "").trim().toLowerCase();
  const action = String(req.query?.action || "").trim().toLowerCase();
  const actorEmail = String(req.query?.actorEmail || "").trim().toLowerCase();
  const limit = Math.min(toPositiveInt(req.query?.limit || 1000, 1000), 5000);

  try {
    const rows = await listAuditLogs({ site, action, actorEmail, limit });
    const header = ["createdAt", "actorEmail", "action", "site", "requestId", "metadata"];
    const dataRows = rows.map((row) => [
      row.createdAt,
      row.actorEmail,
      row.action,
      row.site || "",
      row.requestId || "",
      JSON.stringify(row.metadata || {}),
    ]);

    const csv = [header.join(",")]
      .concat(dataRows.map((row) => row.map(csvCell).join(",")))
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=auditoria-dashboard.csv");
    return res.status(200).send(csv);
  } catch (error) {
    console.error(error);
    return res.status(500).send("No se pudo exportar auditoria");
  }
  }
);

router.get("/dashboard/ops-config", requireDashboardSession, async (_req, res) => {
  return res.status(200).json({
    appRole: env.appRole,
    nodeEnv: env.nodeEnv,
    readiness: {
      checkStripe: env.readinessCheckStripe,
      dbTimeoutMs: env.readinessDbTimeoutMs,
      stripeTimeoutMs: env.readinessStripeTimeoutMs,
    },
    auditLogsRateLimit: {
      windowMs: env.auditLogsRateLimitWindowMs,
      max: env.auditLogsRateLimitMax,
    },
  });
});

router.get(
  "/dashboard/worker-jobs-status",
  requireDashboardSession,
  requireDashboardPermission("dashboard.worker.read"),
  async (_req, res) => {
  const snapshot = getWorkerJobsStatus();
  const jobsInThisProcess = env.appRole === "worker" || env.appRole === "all";

  return res.status(200).json({
    appRole: env.appRole,
    jobsInThisProcess,
    totalJobs: snapshot.totalJobs,
    jobs: snapshot.jobs,
  });
  }
);

router.get(
  "/dashboard/worker-jobs-history",
  requireDashboardSession,
  requireDashboardPermission("dashboard.worker.read"),
  auditLogsRateLimit,
  async (req, res) => {
  const job = String(req.query?.job || "").trim().toLowerCase();
  const status = String(req.query?.status || "").trim().toLowerCase();
  const limit = Math.min(toPositiveInt(req.query?.limit || 50, 50), 500);
  const cursor = String(req.query?.cursor || "").trim();

  const normalizedJob = job === "billing-alerts" ? "billing_alerts" : job;
  const validJobs = new Set(["retention", "billing_alerts"]);
  const validStatuses = new Set(["success", "error"]);

  if (normalizedJob && !validJobs.has(normalizedJob)) {
    return res.status(400).json({ error: "Job invalido" });
  }

  if (status && !validStatuses.has(status)) {
    return res.status(400).json({ error: "Status invalido" });
  }

  if (cursor && !isValidAuditCursor(cursor)) {
    return res.status(400).json({ error: "Cursor de historial invalido" });
  }

  try {
    const page = await listWorkerJobsHistoryPage({ normalizedJob, status, limit, cursor });

    return res.status(200).json({
      total: page.history.length,
      filters: { job: normalizedJob || "", status, limit },
      nextCursor: page.nextCursor,
      history: page.history,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo consultar historial de jobs" });
  }
  }
);

router.get(
  "/dashboard/worker-jobs-history.csv",
  requireDashboardSession,
  requireDashboardPermission("dashboard.worker.read"),
  auditLogsRateLimit,
  async (req, res) => {
  const job = String(req.query?.job || "").trim().toLowerCase();
  const status = String(req.query?.status || "").trim().toLowerCase();
  const limit = Math.min(toPositiveInt(req.query?.limit || 1000, 1000), 5000);
  const cursor = String(req.query?.cursor || "").trim();

  const normalizedJob = job === "billing-alerts" ? "billing_alerts" : job;
  const validJobs = new Set(["retention", "billing_alerts"]);
  const validStatuses = new Set(["success", "error"]);

  if (normalizedJob && !validJobs.has(normalizedJob)) {
    return res.status(400).send("Job invalido");
  }

  if (status && !validStatuses.has(status)) {
    return res.status(400).send("Status invalido");
  }

  if (cursor && !isValidAuditCursor(cursor)) {
    return res.status(400).send("Cursor de historial invalido");
  }

  try {
    const page = await listWorkerJobsHistoryPage({ normalizedJob, status, limit, cursor });
    const header = ["createdAt", "job", "status", "actorEmail", "site", "requestId", "durationMs", "errorMessage", "metadata"];
    const rows = page.history.map((row) => {
      const parsed = parseWorkerJobAction(row.action) || { job: "", status: "" };
      const metadata = row.metadata || {};
      return [
        row.createdAt,
        parsed.job,
        parsed.status,
        row.actorEmail,
        row.site || "",
        row.requestId || "",
        metadata.durationMs ?? "",
        metadata.errorMessage || "",
        JSON.stringify(metadata),
      ];
    });

    const csv = [header.join(",")]
      .concat(rows.map((row) => row.map(csvCell).join(",")))
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=worker-jobs-history.csv");
    if (page.nextCursor) {
      res.setHeader("x-next-cursor", page.nextCursor);
    }
    return res.status(200).send(csv);
  } catch (error) {
    console.error(error);
    return res.status(500).send("No se pudo exportar historial de jobs");
  }
  }
);

router.get("/dashboard/incidents/export", requireDashboardSession, async (req, res) => {
  const params = buildIncidentExportParams(req.query || {});

  try {
    const incidents = await listRecentBillingIncidents(params);
    return res.status(200).json({
      total: incidents.length,
      filters: {
        site: params.site,
        status: params.status,
        days: params.days,
        limit: params.limit,
      },
      incidents,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "No se pudo exportar incidentes" });
  }
});

router.get("/dashboard/incidents/export.csv", requireDashboardSession, async (req, res) => {
  const params = buildIncidentExportParams(req.query || {});

  try {
    const incidents = await listRecentBillingIncidents(params);
    const header = ["createdAt", "site", "type", "status", "severity", "message", "resolvedAt", "rawEventId"];
    const rows = incidents.map((incident) => [
      incident.createdAt,
      incident.site,
      incident.type,
      incident.status,
      incident.severity,
      incident.message,
      incident.resolvedAt || "",
      incident.rawEventId || "",
    ]);

    const csv = [header.join(",")]
      .concat(rows.map((row) => row.map(csvCell).join(",")))
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=incidentes-consenthub.csv");
    return res.status(200).send(csv);
  } catch (error) {
    console.error(error);
    return res.status(500).send("No se pudo exportar incidentes");
  }
});

module.exports = router;
