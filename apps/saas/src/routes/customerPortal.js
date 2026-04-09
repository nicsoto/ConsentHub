const express = require("express");
const {
  requireDashboardSession,
  requireDashboardPermission,
  requireDashboardSiteAccess,
  hasSiteAccess,
} = require("../middleware/dashboardAuth");
const { ensureCsrfCookie, requireCsrf } = require("../middleware/csrf");
const {
  listShops,
  getMonthlyUsageBySites,
  listApiCredentials,
  createApiCredential,
  revokeApiCredential,
  findApiCredentialById,
  createAuditLog,
} = require("../data/store");

const router = express.Router();
router.use(ensureCsrfCookie);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function profileToScopes(profile) {
  const normalized = String(profile || "ingest").trim().toLowerCase();
  if (normalized === "read_export") {
    return ["read", "export"];
  }
  return ["ingest"];
}

function generateApiKey(profile) {
  const crypto = require("crypto");
  const normalized = String(profile || "ingest").trim().toLowerCase();
  const prefix = normalized === "ingest" ? "ch_ing" : "ch_api";
  return `${prefix}_${crypto.randomBytes(20).toString("hex")}`;
}

function renderPortal(csrfToken) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Customer Portal</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #0b1120; color: #e2e8f0; }
      .wrap { width: min(980px, 96vw); margin: 20px auto; }
      .card { background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
      .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .muted { color: #94a3b8; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #223046; text-align: left; padding: 8px; }
      input, select { background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 8px; }
      button { background: #2563eb; color: #fff; border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
      .ghost { background: #1f2937; }
      #secret { display: none; margin-top: 8px; color: #86efac; word-break: break-all; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card row" style="justify-content:space-between;">
        <div>
          <h1 style="margin:0;">Portal de Cliente</h1>
          <div class="muted">Uso mensual, plan y credenciales por sitio</div>
        </div>
        <a href="/auth/logout" style="color:#93c5fd;">Salir</a>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Sitios</h2>
        <div id="shops"></div>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Credenciales</h2>
        <form id="create-form" class="row">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <select name="site" id="site-select"></select>
          <select name="profile">
            <option value="ingest">Ingesta</option>
            <option value="read_export">Lectura + Export</option>
          </select>
          <button type="submit">Crear credencial</button>
        </form>
        <div id="secret"></div>
        <table>
          <thead><tr><th>Sitio</th><th>Scopes</th><th>Estado</th><th>Creada</th><th></th></tr></thead>
          <tbody id="creds"></tbody>
        </table>
      </div>
    </div>

    <script>
      const state = { csrfToken: ${JSON.stringify(csrfToken)} };

      function fmtDate(v) {
        try { return new Date(v).toLocaleString("es-CL"); } catch { return "-"; }
      }

      async function loadData() {
        const res = await fetch('/customer-portal/data');
        if (!res.ok) throw new Error('No se pudo cargar portal');
        const data = await res.json();
        state.csrfToken = data.csrfToken || state.csrfToken;

        const shops = document.getElementById('shops');
        shops.innerHTML = (data.shops || []).map((shop) => {
          return '<div class="card" style="margin:8px 0;">'
            + '<strong>' + shop.site + '</strong>'
            + '<div class="muted">Plan: ' + shop.plan + ' | Billing: ' + shop.billingStatus + ' | Uso 30d: ' + shop.usageLast30Days + '</div>'
            + '</div>';
        }).join('') || '<div class="muted">Sin sitios asignados.</div>';

        const siteSelect = document.getElementById('site-select');
        siteSelect.innerHTML = (data.shops || []).map((shop) => '<option value="' + shop.site + '">' + shop.site + '</option>').join('');

        const creds = document.getElementById('creds');
        creds.innerHTML = (data.credentials || []).map((c) => {
          const scopes = Array.isArray(c.scopes) ? c.scopes.join(',') : '';
          return '<tr>'
            + '<td>' + c.site + '</td>'
            + '<td>' + scopes + '</td>'
            + '<td>' + c.status + '</td>'
            + '<td>' + fmtDate(c.createdAt) + '</td>'
            + '<td><button class="ghost" data-id="' + c.id + '">Revocar</button></td>'
            + '</tr>';
        }).join('');

        creds.querySelectorAll('button[data-id]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const res = await fetch('/customer-portal/api-credentials/' + encodeURIComponent(id) + '/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ _csrf: state.csrfToken }),
            });
            if (res.ok) {
              await loadData();
            }
          });
        });
      }

      document.getElementById('create-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const fd = new FormData(event.currentTarget);
        const payload = {
          site: String(fd.get('site') || ''),
          profile: String(fd.get('profile') || 'ingest'),
          _csrf: state.csrfToken,
        };

        const res = await fetch('/customer-portal/api-credentials/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok) return;

        const secret = document.getElementById('secret');
        secret.style.display = 'block';
        secret.textContent = 'Guardar ahora: ' + body.credential.key;
        await loadData();
      });

      loadData().catch(() => null);
    </script>
  </body>
</html>`;
}

async function auditCustomerAction(req, action, site = "", metadata = {}) {
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
  } catch (_error) {
    // Best effort only.
  }
}

router.get(
  "/customer-portal",
  requireDashboardSession,
  requireDashboardPermission("customer.portal.view"),
  async (req, res) => {
    return res.status(200).send(renderPortal(req.csrfToken));
  }
);

router.get(
  "/customer-portal/data",
  requireDashboardSession,
  requireDashboardPermission("customer.portal.view"),
  async (req, res) => {
    const shops = await listShops();
    const scopedShops = shops.filter((shop) => hasSiteAccess(req.dashboardUser, shop.site));
    const usageMap = await getMonthlyUsageBySites(scopedShops.map((shop) => shop.site), 30);
    const credentials = (await listApiCredentials({ status: "active", limit: 500 }))
      .filter((credential) => hasSiteAccess(req.dashboardUser, credential.site));

    return res.status(200).json({
      csrfToken: req.csrfToken,
      shops: scopedShops.map((shop) => ({
        site: shop.site,
        plan: shop.plan,
        billingStatus: shop.billingStatus,
        usageLast30Days: Number(usageMap[String(shop.site || "").toLowerCase()] || 0),
      })),
      credentials,
    });
  }
);

router.post(
  "/customer-portal/api-credentials/create",
  requireDashboardSession,
  requireDashboardPermission("customer.credentials.write"),
  requireDashboardSiteAccess((req) => req.body?.site),
  requireCsrf,
  async (req, res) => {
    const site = String(req.body?.site || "").trim().toLowerCase();
    const profile = String(req.body?.profile || "ingest").trim().toLowerCase();
    const scopes = profileToScopes(profile);

    if (!site) {
      return res.status(400).json({ error: "Sitio invalido" });
    }

    const key = generateApiKey(profile);
    await createApiCredential({ key, site, scopes, status: "active" });
    await auditCustomerAction(req, "customer.api_credential.create", site, { profile, scopes });

    return res.status(200).json({
      ok: true,
      credential: {
        key,
        site,
        scopes,
      },
    });
  }
);

router.post(
  "/customer-portal/api-credentials/:id/revoke",
  requireDashboardSession,
  requireDashboardPermission("customer.credentials.write"),
  requireCsrf,
  async (req, res) => {
    const credentialId = String(req.params?.id || "").trim();
    if (!credentialId) {
      return res.status(400).json({ error: "Credencial invalida" });
    }

    const target = await findApiCredentialById(credentialId);
    if (!target || !hasSiteAccess(req.dashboardUser, target.site)) {
      return res.status(403).json({ error: "Sin acceso a la credencial" });
    }

    await revokeApiCredential(credentialId);
    await auditCustomerAction(req, "customer.api_credential.revoke", target.site, { credentialId });
    return res.status(200).json({ ok: true });
  }
);

module.exports = router;
