function q(id) {
  return document.getElementById(id);
}

const state = {
  csrfToken: "",
  params: new URLSearchParams(window.location.search),
  latestData: null,
};

function fmtNum(value) {
  return Number(value || 0).toLocaleString("es-CL");
}

function fmtPct(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function fmtDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("es-CL");
}

function showStatus(message, isError = false) {
  const box = q("status-box");
  box.classList.remove("hidden", "ok", "error");
  box.classList.add(isError ? "error" : "ok");
  box.textContent = message;
}

function renderKpis(summary) {
  const kpis = [
    ["Eventos", fmtNum(summary.eventsCount)],
    ["Aceptacion", fmtPct(summary.acceptsRate)],
    ["Sitios en riesgo", fmtNum(summary.atRiskCount)],
    ["Alertas abiertas", fmtNum(summary.openBillingAlerts)],
    ["Incidentes abiertos", fmtNum(summary.openIncidents)],
    ["MTTR 30d", `${Number(summary.mttrHours30d || 0).toFixed(2)}h`],
  ];

  q("kpis").innerHTML = kpis
    .map(
      ([label, value]) => `
      <article class="kpi">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </article>`
    )
    .join("");
}

function renderBars(containerId, items, formatter = (v) => fmtNum(v)) {
  const total = items.reduce((acc, item) => acc + Number(item.value || 0), 0) || 1;
  q(containerId).innerHTML = items
    .map((item) => {
      const pct = (Number(item.value || 0) / total) * 100;
      return `
      <div class="bar">
        <div>
          <div>${item.label}</div>
          <div class="track"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
        </div>
        <strong>${formatter(item.value)}</strong>
      </div>`;
    })
    .join("");
}

function renderShops(rows) {
  q("shops-body").innerHTML = rows
    .map((shop) => {
      const statusClass = shop.billingStatus === "active" ? "ok" : "warn";
      return `
      <tr>
        <td>${shop.site}</td>
        <td>${shop.plan}</td>
        <td><span class="pill ${statusClass}">${shop.billingStatus}</span></td>
        <td>${fmtNum(shop.retentionDays)}</td>
        <td>${fmtNum(shop.usageLast30Days)}</td>
      </tr>`;
    })
    .join("");
}

function renderEvents(rows) {
  q("events-body").innerHTML = rows
    .map(
      (event) => `
      <tr>
        <td>${fmtDate(event.timestamp)}</td>
        <td>${event.site || "-"}</td>
        <td>${event.category || "-"}</td>
        <td>${event.action || "-"}</td>
        <td>${event.country || "-"}</td>
      </tr>`
    )
    .join("");
}

function renderSiteSelects(shops) {
  const options = shops
    .map((shop) => `<option value="${shop.site}">${shop.site}</option>`)
    .join("");

  q("retention-site").innerHTML = options;
  q("credential-site").innerHTML = options;
}

function renderAlerts(alerts) {
  q("alerts-body").innerHTML = alerts
    .map(
      (alert) => `
      <tr>
        <td>${alert.site}</td>
        <td>${alert.severity}</td>
        <td>${alert.message}</td>
        <td><button type="button" class="mini" data-action="resolve-alert" data-id="${alert.id}">Resolver</button></td>
      </tr>`
    )
    .join("");
}

function renderCredentials(credentials) {
  q("credentials-body").innerHTML = credentials
    .map(
      (credential) => `
      <tr>
        <td>${credential.site}</td>
        <td>${Array.isArray(credential.scopes) ? credential.scopes.join(",") : ""}</td>
        <td>${credential.status}</td>
        <td>${fmtDate(credential.createdAt)}</td>
        <td>${credential.lastUsedAt ? fmtDate(credential.lastUsedAt) : "-"}</td>
        <td><button type="button" class="mini" data-action="revoke-credential" data-id="${credential.id}">Revocar</button></td>
      </tr>`
    )
    .join("");
}

function renderAccessPolicies(policies, canManageAccess) {
  const section = q("access-admin");
  if (!canManageAccess) {
    section.classList.add("hidden");
    q("access-policies-body").innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  q("access-policies-body").innerHTML = (Array.isArray(policies) ? policies : [])
    .map(
      (policy) => `
      <tr>
        <td>${policy.email}</td>
        <td>${policy.role}</td>
        <td>${Array.isArray(policy.sites) ? policy.sites.join(",") : "*"}</td>
        <td>${fmtDate(policy.updatedAt)}</td>
        <td><button type="button" class="mini" data-action="delete-policy" data-email="${policy.email}">Eliminar</button></td>
      </tr>`
    )
    .join("");
}

function revealSecret(credential) {
  const box = q("secret-box");
  box.classList.remove("hidden");
  box.innerHTML = `<strong>Guardar ahora:</strong> ${credential.key} <span class="muted">(sitio ${credential.site}, scopes ${credential.scopes.join(",")})</span>`;
}

async function apiPost(path, payload = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-requested-with": "dashboard-v2",
    },
    body: JSON.stringify({
      ...payload,
      _csrf: state.csrfToken,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Operacion fallo (${res.status})`);
  }
  return body;
}

async function refreshData() {
  const res = await fetch(`/dashboard-v2/data?${state.params.toString()}`, {
    headers: {
      "x-requested-with": "dashboard-v2",
    },
  });

  if (!res.ok) {
    throw new Error(`Dashboard V2 fallo con status ${res.status}`);
  }

  const data = await res.json();
  state.latestData = data;
  state.csrfToken = data.csrfToken || "";

  renderKpis(data.summary);
  renderBars(
    "actions-bars",
    Object.entries(data.actions || {}).map(([label, value]) => ({ label, value })),
    (v) => fmtNum(v)
  );
  renderBars(
    "categories-bars",
    (data.topCategories || []).map((item) => ({ label: item.category, value: item.count })),
    (v) => fmtNum(v)
  );
  renderShops(data.topShops || []);
  renderEvents(data.recentEvents || []);
  renderSiteSelects(data.shops || []);
  renderAlerts(data.billingAlerts || []);
  renderCredentials(data.apiCredentials || []);
  renderAccessPolicies(data.accessPolicies || [], Boolean(data.user?.canManageAccess));
}

function bindFilters() {
  const form = q("filters-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const params = new URLSearchParams();

    for (const [key, value] of formData.entries()) {
      if (String(value || "").trim()) {
        params.set(key, String(value).trim());
      }
    }

    try {
      state.params = params;
      await refreshData();
      history.replaceState({}, "", `/dashboard-v2?${params.toString()}`);
      showStatus("Filtros actualizados.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });
}

function bindActions() {
  q("retention-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      site: String(formData.get("site") || ""),
      retentionDays: Number(formData.get("retentionDays") || 0),
    };

    try {
      const res = await apiPost("/dashboard-v2/retention", payload);
      await refreshData();
      showStatus(res.message || "Retencion actualizada.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  q("retention-run").addEventListener("click", async () => {
    try {
      const res = await apiPost("/dashboard-v2/retention/run");
      await refreshData();
      showStatus(res.message || "Limpieza ejecutada.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  q("alerts-escalate").addEventListener("click", async () => {
    try {
      const res = await apiPost("/dashboard-v2/billing-alerts/escalate");
      await refreshData();
      showStatus(res.message || "Escalacion completada.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  q("alerts-body").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='resolve-alert']");
    if (!button) {
      return;
    }

    try {
      const res = await apiPost(`/dashboard-v2/billing-alerts/${button.dataset.id}/resolve`);
      await refreshData();
      showStatus(res.message || "Alerta resuelta.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  q("create-credential-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      site: String(formData.get("site") || ""),
      profile: String(formData.get("profile") || "ingest"),
    };

    try {
      const res = await apiPost("/dashboard-v2/api-credentials/create", payload);
      if (res.credential) {
        revealSecret(res.credential);
      }
      await refreshData();
      showStatus(res.message || "Credencial creada.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  q("regenerate-ingest").addEventListener("click", async () => {
    const site = q("credential-site").value;
    try {
      const res = await apiPost("/dashboard-v2/api-credentials/regenerate-ingest", { site });
      if (res.credential) {
        revealSecret(res.credential);
      }
      await refreshData();
      showStatus(res.message || "Key regenerada.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  q("credentials-body").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='revoke-credential']");
    if (!button) {
      return;
    }

    try {
      const res = await apiPost(`/dashboard-v2/api-credentials/${button.dataset.id}/revoke`);
      await refreshData();
      showStatus(res.message || "Credencial revocada.");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  const accessPolicyForm = q("access-policy-form");
  if (accessPolicyForm) {
    accessPolicyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const payload = {
        email: String(formData.get("email") || "").trim().toLowerCase(),
        role: String(formData.get("role") || "analyst").trim().toLowerCase(),
        sites: String(formData.get("sites") || "")
          .split(",")
          .map((site) => site.trim().toLowerCase())
          .filter(Boolean),
      };

      try {
        const res = await apiPost("/dashboard-v2/access-policies/upsert", payload);
        await refreshData();
        showStatus(res.message || "Politica guardada.");
      } catch (error) {
        showStatus(error.message, true);
      }
    });
  }

  const accessPoliciesBody = q("access-policies-body");
  if (accessPoliciesBody) {
    accessPoliciesBody.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action='delete-policy']");
      if (!button) {
        return;
      }

      try {
        const res = await apiPost("/dashboard-v2/access-policies/delete", {
          email: button.dataset.email,
        });
        await refreshData();
        showStatus(res.message || "Politica eliminada.");
      } catch (error) {
        showStatus(error.message, true);
      }
    });
  }
}

async function bootstrap() {
  bindFilters();
  bindActions();

  const site = state.params.get("site") || "";
  const days = state.params.get("days") || "30";
  const limit = state.params.get("limit") || "80";

  const form = q("filters-form");
  form.site.value = site;
  form.days.value = days;
  form.limit.value = limit;

  await refreshData();
}

bootstrap().catch((error) => {
  showStatus(error.message, true);
});
