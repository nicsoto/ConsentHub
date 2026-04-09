const {
  SESSION_COOKIE,
  parseCookies,
  verifySessionValue,
  shouldRefreshSession,
  createSessionValue,
  attachSessionCookie,
} = require("../services/session");
const { sessionSecret, isSecureCookies } = require("../config/env");

const rolePermissions = {
  admin: new Set(["*"]),
  operator: new Set([
    "dashboard.view",
    "dashboard.retention.write",
    "dashboard.credentials.write",
    "dashboard.billing_alerts.write",
    "dashboard.audit.read",
    "dashboard.worker.read",
  ]),
  billing_manager: new Set(["dashboard.view", "dashboard.billing_alerts.write", "dashboard.audit.read"]),
  analyst: new Set(["dashboard.view", "dashboard.audit.read", "dashboard.worker.read"]),
  customer_owner: new Set([
    "customer.portal.view",
    "customer.credentials.write",
    "customer.billing.view",
  ]),
  customer_viewer: new Set(["customer.portal.view", "customer.billing.view"]),
};

function hasPermission(user, permission) {
  const role = String(user?.role || "admin").trim().toLowerCase();
  const set = rolePermissions[role] || rolePermissions.analyst;
  return set.has("*") || set.has(permission);
}

function hasSiteAccess(user, site) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  if (!normalizedSite) {
    return true;
  }

  const sites = Array.isArray(user?.sites) ? user.sites : ["*"];
  return sites.includes("*") || sites.includes(normalizedSite);
}

function requireDashboardSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || "");
  const raw = cookies[SESSION_COOKIE];
  const session = verifySessionValue(raw, sessionSecret);

  if (!session) {
    return res.redirect("/auth/login");
  }

  if (shouldRefreshSession(session)) {
    const renewed = createSessionValue(session.email, sessionSecret, {
      role: session.role,
      sites: session.sites,
    });
    attachSessionCookie(res, renewed, isSecureCookies);
  }

  req.dashboardUser = session;
  return next();
}

function requireDashboardPermission(permission) {
  return (req, res, next) => {
    if (!req.dashboardUser || !hasPermission(req.dashboardUser, permission)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

function requireDashboardSiteAccess(siteResolver) {
  return (req, res, next) => {
    const site = siteResolver(req);
    if (!hasSiteAccess(req.dashboardUser, site)) {
      return res.status(403).json({ error: "Sin acceso al sitio" });
    }
    return next();
  };
}

module.exports = {
  requireDashboardSession,
  requireDashboardPermission,
  requireDashboardSiteAccess,
  hasPermission,
  hasSiteAccess,
};
