const { prisma } = require("../lib/prisma");
const crypto = require("crypto");

const memory = {
  shops: [],
  events: [],
  billingBySite: {},
  billingWebhookEvents: new Set(),
  billingAlerts: [],
  criticalEmailLogByAlertKey: {},
  apiCredentials: [],
  magicLinkTokens: {},
  rateLimitBuckets: {},
  auditLogs: [],
  dashboardAccessPolicies: [],
};

function isFallbackEnabled() {
  return process.env.NODE_ENV === "test" || process.env.USE_IN_MEMORY_STORE === "true";
}

function resetStoreForTests() {
  memory.shops = [];
  memory.events = [];
  memory.billingBySite = {};
  memory.billingWebhookEvents = new Set();
  memory.billingAlerts = [];
  memory.criticalEmailLogByAlertKey = {};
  memory.apiCredentials = [];
  memory.magicLinkTokens = {};
  memory.rateLimitBuckets = {};
  memory.auditLogs = [];
  memory.dashboardAccessPolicies = [];
}

function normalizeDashboardRole(value) {
  const role = String(value || "admin").trim().toLowerCase();
  const allowed = new Set(["admin", "operator", "billing_manager", "analyst", "customer_owner", "customer_viewer"]);
  return allowed.has(role) ? role : "admin";
}

function normalizeDashboardSites(input) {
  if (!Array.isArray(input)) {
    return ["*"];
  }
  const sites = [...new Set(input.map((site) => String(site || "").trim().toLowerCase()).filter(Boolean))];
  if (sites.length === 0 || sites.includes("*")) {
    return ["*"];
  }
  return sites;
}

function sanitizeAuditMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const maxPairs = 20;
  const result = {};
  const keys = Object.keys(input).slice(0, maxPairs);
  for (const key of keys) {
    const value = input[key];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.slice(0, 20).map((item) => String(item));
      continue;
    }
    if (typeof value === "object") {
      result[key] = "[object]";
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

async function createAuditLog(entry = {}) {
  const actorEmail = String(entry.actorEmail || "").trim().toLowerCase();
  const action = String(entry.action || "").trim().toLowerCase();
  const site = String(entry.site || "").trim().toLowerCase();
  const requestId = String(entry.requestId || "").trim();
  const metadata = sanitizeAuditMetadata(entry.metadata || {});

  if (!actorEmail || !action) {
    throw new Error("actorEmail and action are required for audit logs");
  }

  return withFallback(
    async () => {
      return prisma.auditLog.create({
        data: {
          actorEmail,
          action,
          site: site || null,
          requestId: requestId || null,
          metadata,
        },
      });
    },
    () => {
      const created = {
        id: `audit_${memory.auditLogs.length + 1}`,
        createdAt: new Date().toISOString(),
        actorEmail,
        action,
        site: site || null,
        requestId: requestId || null,
        metadata,
      };
      memory.auditLogs.push(created);
      return {
        ...created,
        createdAt: new Date(created.createdAt),
      };
    }
  );
}

async function listAuditLogs(options = {}) {
  const page = await listAuditLogsPage(options);
  return page.rows;
}

async function upsertDashboardAccessPolicy(input = {}) {
  const email = String(input.email || "").trim().toLowerCase();
  const role = normalizeDashboardRole(input.role);
  const sites = normalizeDashboardSites(input.sites);
  const status = String(input.status || "active").trim().toLowerCase() === "inactive" ? "inactive" : "active";

  if (!email) {
    throw new Error("email is required");
  }

  return withFallback(
    async () => {
      return prisma.dashboardAccessPolicy.upsert({
        where: { email },
        update: { role, sites, status },
        create: { email, role, sites, status },
      });
    },
    () => {
      const found = memory.dashboardAccessPolicies.find((row) => row.email === email);
      if (found) {
        found.role = role;
        found.sites = sites;
        found.status = status;
        found.updatedAt = new Date().toISOString();
        return {
          ...found,
          createdAt: new Date(found.createdAt),
          updatedAt: new Date(found.updatedAt),
        };
      }

      const created = {
        id: `dap_${memory.dashboardAccessPolicies.length + 1}`,
        email,
        role,
        sites,
        status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      memory.dashboardAccessPolicies.push(created);
      return {
        ...created,
        createdAt: new Date(created.createdAt),
        updatedAt: new Date(created.updatedAt),
      };
    }
  );
}

async function listDashboardAccessPolicies(options = {}) {
  const status = String(options.status || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit || 200), 1000));

  return withFallback(
    async () => {
      const where = {};
      if (status) {
        where.status = status;
      }
      return prisma.dashboardAccessPolicy.findMany({
        where,
        orderBy: { email: "asc" },
        take: limit,
      });
    },
    () => {
      return memory.dashboardAccessPolicies
        .filter((row) => (status ? String(row.status || "") === status : true))
        .sort((a, b) => String(a.email).localeCompare(String(b.email)))
        .slice(0, limit)
        .map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        }));
    }
  );
}

async function findDashboardAccessPolicyByEmail(emailInput) {
  const email = String(emailInput || "").trim().toLowerCase();
  if (!email) {
    return null;
  }

  return withFallback(
    async () => {
      return prisma.dashboardAccessPolicy.findUnique({ where: { email } });
    },
    () => {
      const row = memory.dashboardAccessPolicies.find((item) => item.email === email) || null;
      if (!row) {
        return null;
      }
      return {
        ...row,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      };
    }
  );
}

async function deleteDashboardAccessPolicyByEmail(emailInput) {
  const email = String(emailInput || "").trim().toLowerCase();
  if (!email) {
    throw new Error("email is required");
  }

  return withFallback(
    async () => {
      await prisma.dashboardAccessPolicy.delete({ where: { email } });
      return { deleted: true };
    },
    () => {
      const before = memory.dashboardAccessPolicies.length;
      memory.dashboardAccessPolicies = memory.dashboardAccessPolicies.filter((row) => row.email !== email);
      return { deleted: before !== memory.dashboardAccessPolicies.length };
    }
  );
}

function encodeAuditCursor(value) {
  if (!value || !value.createdAt || !value.id) {
    return "";
  }

  const payload = JSON.stringify({
    createdAt: new Date(value.createdAt).toISOString(),
    id: String(value.id),
  });

  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeAuditCursor(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.createdAt);
    const id = String(parsed.id || "").trim();
    if (Number.isNaN(createdAt.getTime()) || !id) {
      return null;
    }
    return { createdAt, id };
  } catch (_error) {
    return null;
  }
}

function isValidAuditCursor(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }
  return Boolean(decodeAuditCursor(raw));
}

async function listAuditLogsPage(options = {}) {
  const site = String(options.site || "").trim().toLowerCase();
  const action = String(options.action || "").trim().toLowerCase();
  const actorEmail = String(options.actorEmail || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 1000));
  const cursor = decodeAuditCursor(options.cursor);

  return withFallback(
    async () => {
      const where = {};
      if (site) {
        where.site = site;
      }
      if (action) {
        where.action = action;
      }
      if (actorEmail) {
        where.actorEmail = actorEmail;
      }

      if (cursor) {
        where.OR = [
          { createdAt: { lt: cursor.createdAt } },
          {
            AND: [
              { createdAt: cursor.createdAt },
              { id: { lt: cursor.id } },
            ],
          },
        ];
      }

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });

      const hasNext = rows.length > limit;
      const pageRows = hasNext ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1] || null;

      return {
        rows: pageRows,
        nextCursor: hasNext && last ? encodeAuditCursor(last) : "",
      };
    },
    () => {
      const filtered = memory.auditLogs
        .filter((row) => {
          if (site && String(row.site || "").toLowerCase() !== site) {
            return false;
          }
          if (action && String(row.action || "").toLowerCase() !== action) {
            return false;
          }
          if (actorEmail && String(row.actorEmail || "").toLowerCase() !== actorEmail) {
            return false;
          }
          return true;
        })
        .sort((a, b) => {
          const timeDiff = new Date(b.createdAt) - new Date(a.createdAt);
          if (timeDiff !== 0) {
            return timeDiff;
          }
          return String(b.id).localeCompare(String(a.id));
        });

      const afterCursor = cursor
        ? filtered.filter((row) => {
          const rowTime = new Date(row.createdAt);
          if (rowTime < cursor.createdAt) {
            return true;
          }
          if (rowTime.getTime() === cursor.createdAt.getTime() && String(row.id) < cursor.id) {
            return true;
          }
          return false;
        })
        : filtered;

      const pageRows = afterCursor
        .slice(0, limit)
        .map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt),
        }));

      const last = pageRows[pageRows.length - 1] || null;
      const hasNext = afterCursor.length > pageRows.length;

      return {
        rows: pageRows,
        nextCursor: hasNext && last ? encodeAuditCursor(last) : "",
      };
    }
  );
}

async function consumeRateLimitBucket(key, options = {}) {
  const safeKey = String(key || "").trim();
  const now = options.now instanceof Date ? options.now : new Date();
  const windowMs = Math.max(1000, Number(options.windowMs || 60_000));
  const max = Math.max(1, Number(options.max || 120));
  const nextReset = new Date(now.getTime() + windowMs);

  if (!safeKey) {
    throw new Error("rate limit key is required");
  }

  return withFallback(
    async () => {
      const row = await prisma.rateLimitBucket.findUnique({ where: { key: safeKey } });

      if (!row || row.resetAt <= now) {
        await prisma.rateLimitBucket.upsert({
          where: { key: safeKey },
          update: {
            count: 1,
            resetAt: nextReset,
          },
          create: {
            key: safeKey,
            count: 1,
            resetAt: nextReset,
          },
        });

        return { allowed: true, count: 1, resetAt: nextReset, retryAfterSeconds: 0 };
      }

      if (row.count >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((row.resetAt.getTime() - now.getTime()) / 1000));
        return {
          allowed: false,
          count: row.count,
          resetAt: row.resetAt,
          retryAfterSeconds,
        };
      }

      const updated = await prisma.rateLimitBucket.update({
        where: { key: safeKey },
        data: {
          count: row.count + 1,
        },
      });

      return {
        allowed: true,
        count: updated.count,
        resetAt: updated.resetAt,
        retryAfterSeconds: 0,
      };
    },
    () => {
      const current = memory.rateLimitBuckets[safeKey];

      if (!current || new Date(current.resetAt) <= now) {
        memory.rateLimitBuckets[safeKey] = {
          count: 1,
          resetAt: nextReset.toISOString(),
        };
        return { allowed: true, count: 1, resetAt: nextReset, retryAfterSeconds: 0 };
      }

      if (current.count >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((new Date(current.resetAt).getTime() - now.getTime()) / 1000));
        return {
          allowed: false,
          count: current.count,
          resetAt: new Date(current.resetAt),
          retryAfterSeconds,
        };
      }

      current.count += 1;
      memory.rateLimitBuckets[safeKey] = current;

      return {
        allowed: true,
        count: current.count,
        resetAt: new Date(current.resetAt),
        retryAfterSeconds: 0,
      };
    }
  );
}

async function purgeExpiredRateLimitBuckets(now = new Date()) {
  return withFallback(
    async () => {
      const result = await prisma.rateLimitBucket.deleteMany({
        where: {
          resetAt: { lt: now },
        },
      });
      return result.count;
    },
    () => {
      let removed = 0;
      for (const key of Object.keys(memory.rateLimitBuckets)) {
        const row = memory.rateLimitBuckets[key];
        if (!row) {
          continue;
        }
        if (new Date(row.resetAt) < now) {
          delete memory.rateLimitBuckets[key];
          removed += 1;
        }
      }
      return removed;
    }
  );
}

async function saveMagicLinkToken(token, email, expiresAt) {
  const safeToken = String(token || "").trim();
  const safeEmail = String(email || "").trim().toLowerCase();
  const expiryDate = new Date(expiresAt);

  if (!safeToken || !safeEmail || Number.isNaN(expiryDate.getTime())) {
    throw new Error("token, email and expiresAt are required");
  }

  return withFallback(
    async () => {
      return prisma.magicLinkToken.upsert({
        where: { token: safeToken },
        update: {
          email: safeEmail,
          expiresAt: expiryDate,
          usedAt: null,
        },
        create: {
          token: safeToken,
          email: safeEmail,
          expiresAt: expiryDate,
        },
      });
    },
    () => {
      memory.magicLinkTokens[safeToken] = {
        token: safeToken,
        email: safeEmail,
        expiresAt: expiryDate.toISOString(),
        usedAt: null,
      };
      return {
        ...memory.magicLinkTokens[safeToken],
        expiresAt: expiryDate,
      };
    }
  );
}

async function consumeMagicLinkToken(token, now = new Date()) {
  const safeToken = String(token || "").trim();
  if (!safeToken) {
    return null;
  }

  return withFallback(
    async () => {
      const row = await prisma.magicLinkToken.findUnique({
        where: { token: safeToken },
      });

      if (!row) {
        return null;
      }

      if (row.usedAt || row.expiresAt <= now) {
        return null;
      }

      await prisma.magicLinkToken.update({
        where: { token: safeToken },
        data: { usedAt: now },
      });

      return String(row.email || "").toLowerCase();
    },
    () => {
      const row = memory.magicLinkTokens[safeToken];
      if (!row) {
        return null;
      }

      if (row.usedAt) {
        return null;
      }

      if (new Date(row.expiresAt) <= now) {
        return null;
      }

      row.usedAt = now.toISOString();
      return String(row.email || "").toLowerCase();
    }
  );
}

async function purgeExpiredMagicLinkTokens(now = new Date()) {
  return withFallback(
    async () => {
      const result = await prisma.magicLinkToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { usedAt: { not: null } },
          ],
        },
      });

      return result.count;
    },
    () => {
      let removed = 0;
      for (const token of Object.keys(memory.magicLinkTokens)) {
        const row = memory.magicLinkTokens[token];
        if (!row) {
          continue;
        }

        const isExpired = new Date(row.expiresAt) < now;
        const isUsed = Boolean(row.usedAt);
        if (isExpired || isUsed) {
          delete memory.magicLinkTokens[token];
          removed += 1;
        }
      }

      return removed;
    }
  );
}

function normalizeScopes(scopes = []) {
  const input = Array.isArray(scopes) ? scopes : [];
  return [...new Set(input.map((scope) => String(scope || "").trim().toLowerCase()).filter(Boolean))];
}

function hashApiCredentialKey(key) {
  return crypto.createHash("sha256").update(String(key || "").trim()).digest("hex");
}

function toApiCredentialFingerprintFromStoredKey(storedKey) {
  const normalized = String(storedKey || "").trim();
  if (!normalized) {
    return "";
  }
  return `sha256:${normalized.slice(0, 12)}`;
}

function mapApiCredentialRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    site: String(row.site || "").toLowerCase(),
    scopes: normalizeScopes(row.scopes),
    status: String(row.status || "").toLowerCase(),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt || null,
    keyFingerprint: toApiCredentialFingerprintFromStoredKey(row.key),
  };
}

async function createApiCredential(input = {}) {
  const key = String(input.key || "").trim();
  const site = String(input.site || "").trim().toLowerCase();
  const scopes = normalizeScopes(input.scopes);
  const status = String(input.status || "active").trim().toLowerCase();
  const keyHash = hashApiCredentialKey(key);

  if (!key || !site || scopes.length === 0) {
    throw new Error("key, site and scopes are required for api credentials");
  }

  return withFallback(
    async () => {
      const created = await prisma.apiCredential.create({
        data: {
          key: keyHash,
          site,
          scopes,
          status,
        },
      });
      return mapApiCredentialRow(created);
    },
    () => {
      const created = {
        id: `cred_${memory.apiCredentials.length + 1}`,
        key: keyHash,
        site,
        scopes,
        status,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      };
      memory.apiCredentials.push(created);
      return mapApiCredentialRow({
        ...created,
        createdAt: new Date(created.createdAt),
      });
    }
  );
}

async function findActiveApiCredentialByKey(key) {
  const safeKey = String(key || "").trim();
  if (!safeKey) {
    return null;
  }

  const keyHash = hashApiCredentialKey(safeKey);

  return withFallback(
    async () => {
      const row = await prisma.apiCredential.findFirst({
        where: {
          key: {
            in: [keyHash, safeKey],
          },
          status: "active",
        },
      });
      if (!row) {
        return null;
      }

      if (row.key !== keyHash) {
        await prisma.apiCredential.updateMany({
          where: {
            id: row.id,
            key: safeKey,
          },
          data: {
            key: keyHash,
          },
        });
      }

      return mapApiCredentialRow({
        ...row,
        key: keyHash,
      });
    },
    () => {
      const found = memory.apiCredentials.find((cred) => {
        if (cred.status !== "active") {
          return false;
        }
        return cred.key === keyHash || cred.key === safeKey;
      });
      if (!found) {
        return null;
      }

      if (found.key !== keyHash) {
        found.key = keyHash;
      }

      return mapApiCredentialRow({
        ...found,
        createdAt: new Date(found.createdAt),
        lastUsedAt: found.lastUsedAt ? new Date(found.lastUsedAt) : null,
      });
    }
  );
}

async function touchApiCredentialLastUsed(credentialId, when = new Date()) {
  const id = String(credentialId || "").trim();
  if (!id) {
    return false;
  }

  return withFallback(
    async () => {
      await prisma.apiCredential.updateMany({
        where: {
          id,
          status: "active",
        },
        data: {
          lastUsedAt: when,
        },
      });

      return true;
    },
    () => {
      const found = memory.apiCredentials.find((cred) => cred.id === id && cred.status === "active");
      if (!found) {
        return false;
      }

      found.lastUsedAt = when.toISOString();
      return true;
    }
  );
}

async function listApiCredentials(options = {}) {
  const site = String(options.site || "").trim().toLowerCase();
  const status = String(options.status || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 1000));

  return withFallback(
    async () => {
      const where = {};
      if (site) {
        where.site = site;
      }
      if (status) {
        where.status = status;
      }

      const rows = await prisma.apiCredential.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return rows.map((row) => mapApiCredentialRow(row));
    },
    () => {
      return memory.apiCredentials
        .filter((cred) => {
          if (site && String(cred.site || "").toLowerCase() !== site) {
            return false;
          }
          if (status && String(cred.status || "").toLowerCase() !== status) {
            return false;
          }
          return true;
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit)
        .map((cred) => mapApiCredentialRow({
          ...cred,
          createdAt: new Date(cred.createdAt),
          lastUsedAt: cred.lastUsedAt ? new Date(cred.lastUsedAt) : null,
        }));
    }
  );
}

async function findApiCredentialById(credentialId) {
  const id = String(credentialId || "").trim();
  if (!id) {
    return null;
  }

  return withFallback(
    async () => {
      const row = await prisma.apiCredential.findUnique({
        where: { id },
      });
      if (!row) {
        return null;
      }
      return mapApiCredentialRow(row);
    },
    () => {
      const row = memory.apiCredentials.find((cred) => cred.id === id);
      if (!row) {
        return null;
      }
      return mapApiCredentialRow({
        ...row,
        createdAt: new Date(row.createdAt),
        lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
      });
    }
  );
}

async function revokeApiCredential(credentialId) {
  const id = String(credentialId || "").trim();
  if (!id) {
    throw new Error("credentialId is required");
  }

  return withFallback(
    async () => {
      return prisma.apiCredential.update({
        where: { id },
        data: { status: "revoked" },
      });
    },
    () => {
      const found = memory.apiCredentials.find((cred) => cred.id === id);
      if (!found) {
        throw new Error("API credential not found");
      }

      found.status = "revoked";
      return {
        ...found,
        site: String(found.site || "").toLowerCase(),
        scopes: normalizeScopes(found.scopes),
        createdAt: new Date(found.createdAt),
        lastUsedAt: found.lastUsedAt ? new Date(found.lastUsedAt) : null,
      };
    }
  );
}

async function createBillingAlert(alert = {}) {
  const site = String(alert.site || "").trim();
  const type = String(alert.type || "payment_issue").trim();
  const severity = String(alert.severity || "warning").trim();
  const message = String(alert.message || "").trim();
  const rawEventId = String(alert.rawEventId || "").trim();

  if (!site || !message) {
    throw new Error("site and message are required for billing alerts");
  }

  return withFallback(
    async () => {
      return prisma.billingAlert.create({
        data: {
          site,
          type,
          severity,
          message,
          rawEventId: rawEventId || null,
          status: "open",
          lastCriticalEmailAt: null,
        },
      });
    },
    () => {
      const created = {
        id: `alert_${memory.billingAlerts.length + 1}`,
        site,
        type,
        severity,
        message,
        rawEventId,
        status: "open",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        lastCriticalEmailAt: null,
      };
      memory.billingAlerts.push(created);
      return {
        ...created,
        createdAt: new Date(created.createdAt),
      };
    }
  );
}

async function listOpenBillingAlerts(limit = 20) {
  const max = Math.max(1, Math.min(Number(limit || 20), 100));

  return withFallback(
    async () => {
      return prisma.billingAlert.findMany({
        where: { status: "open" },
        orderBy: { createdAt: "desc" },
        take: max,
      });
    },
    () => {
      return memory.billingAlerts
        .filter((a) => a.status === "open")
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, max)
        .map((a) => ({
          ...a,
          createdAt: new Date(a.createdAt),
          resolvedAt: a.resolvedAt ? new Date(a.resolvedAt) : null,
        }));
    }
  );
}

function buildIncidentOptions(options = {}) {
  if (typeof options === "number") {
    return {
      site: "",
      status: "",
      from: null,
      to: null,
      limit: Math.max(1, Math.min(Number(options || 20), 1000)),
    };
  }

  const site = String(options.site || "").trim();
  const status = String(options.status || "").trim();
  const from = options.from ? new Date(options.from) : null;
  const to = options.to ? new Date(options.to) : null;
  const rawLimit = Number(options.limit || 20);

  return {
    site,
    status,
    from: from && !Number.isNaN(from.getTime()) ? from : null,
    to: to && !Number.isNaN(to.getTime()) ? to : null,
    limit: Math.max(1, Math.min(rawLimit, 1000)),
  };
}

async function listRecentBillingIncidents(options = 20) {
  const normalized = buildIncidentOptions(options);

  return withFallback(
    async () => {
      const where = {};
      if (normalized.site) {
        where.site = normalized.site;
      }
      if (normalized.status) {
        where.status = normalized.status;
      }
      if (normalized.from || normalized.to) {
        where.createdAt = {};
        if (normalized.from) {
          where.createdAt.gte = normalized.from;
        }
        if (normalized.to) {
          where.createdAt.lte = normalized.to;
        }
      }

      return prisma.billingAlert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: normalized.limit,
      });
    },
    () => {
      return [...memory.billingAlerts]
        .filter((a) => {
          if (normalized.site && a.site !== normalized.site) {
            return false;
          }
          if (normalized.status && a.status !== normalized.status) {
            return false;
          }
          const createdAt = new Date(a.createdAt);
          if (normalized.from && createdAt < normalized.from) {
            return false;
          }
          if (normalized.to && createdAt > normalized.to) {
            return false;
          }
          return true;
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, normalized.limit)
        .map((a) => ({
          ...a,
          createdAt: new Date(a.createdAt),
          resolvedAt: a.resolvedAt ? new Date(a.resolvedAt) : null,
          lastCriticalEmailAt: a.lastCriticalEmailAt ? new Date(a.lastCriticalEmailAt) : null,
        }));
    }
  );
}

function toAlertKey(alert) {
  const site = String(alert?.site || "").trim();
  const type = String(alert?.type || "payment_failed").trim();
  return `${site}:${type}`;
}

function splitAlertKey(key) {
  const parts = String(key || "").split(":");
  const site = String(parts[0] || "").trim();
  const type = String(parts.slice(1).join(":") || "").trim();
  if (!site || !type) {
    return null;
  }
  return { site, type };
}

async function getCriticalAlertsEligibleForEmail(alerts = [], cooldownMinutes = 180, now = new Date()) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return [];
  }

  const uniqueByKey = new Map();
  for (const alert of alerts) {
    const id = String(alert?.id || "").trim();
    const site = String(alert?.site || "").trim();
    const type = String(alert?.type || "payment_failed").trim();
    const message = String(alert?.message || "").trim();

    if (!id || !site || !message) {
      continue;
    }

    const candidate = {
      id,
      site,
      type,
      message,
    };

    uniqueByKey.set(toAlertKey(candidate), candidate);
  }

  const candidates = [...uniqueByKey.values()];
  if (candidates.length === 0) {
    return [];
  }

  const cooldownMs = Math.max(1, Number(cooldownMinutes || 180)) * 60 * 1000;

  return withFallback(
    async () => {
      const whereByKey = candidates.map((alert) => ({
        site: alert.site,
        type: alert.type,
      }));

      const rows = await prisma.billingAlert.findMany({
        where: {
          OR: whereByKey,
          lastCriticalEmailAt: {
            not: null,
          },
        },
        select: {
          site: true,
          type: true,
          lastCriticalEmailAt: true,
        },
      });

      const byKey = new Map();
      for (const row of rows) {
        const key = toAlertKey(row);
        const current = byKey.get(key);
        if (!current || row.lastCriticalEmailAt > current) {
          byKey.set(key, row.lastCriticalEmailAt);
        }
      }

      return candidates.filter((alert) => {
        const last = byKey.get(toAlertKey(alert));
        if (!last) {
          return true;
        }
        return now.getTime() - last.getTime() >= cooldownMs;
      });
    },
    () => {
      return candidates.filter((alert) => {
        const iso = memory.criticalEmailLogByAlertKey[toAlertKey(alert)];
        if (!iso) {
          return true;
        }
        const last = new Date(iso);
        if (Number.isNaN(last.getTime())) {
          return true;
        }
        return now.getTime() - last.getTime() >= cooldownMs;
      });
    }
  );
}

async function markCriticalAlertsEmailSent(alerts = [], now = new Date()) {
  const uniqueKeys = [...new Set((Array.isArray(alerts) ? alerts : []).map((alert) => toAlertKey(alert)))]
    .filter(Boolean);

  if (uniqueKeys.length === 0) {
    return 0;
  }

  return withFallback(
    async () => {
      let updated = 0;
      for (const key of uniqueKeys) {
        const parsed = splitAlertKey(key);
        if (!parsed) {
          continue;
        }

        const result = await prisma.billingAlert.updateMany({
          where: {
            site: parsed.site,
            type: parsed.type,
            severity: "critical",
          },
          data: {
            lastCriticalEmailAt: now,
          },
        });

        updated += result.count;
      }

      return updated;
    },
    () => {
      const iso = now.toISOString();
      let updated = 0;

      for (const key of uniqueKeys) {
        memory.criticalEmailLogByAlertKey[key] = iso;
        const parsed = splitAlertKey(key);
        if (!parsed) {
          continue;
        }

        for (const alert of memory.billingAlerts) {
          if (alert.site !== parsed.site || alert.type !== parsed.type || alert.severity !== "critical") {
            continue;
          }
          alert.lastCriticalEmailAt = iso;
          updated += 1;
        }
      }

      return updated;
    }
  );
}

async function getBillingMttrHours(days = 30, now = new Date()) {
  const from = new Date(now.getTime() - Number(days || 30) * 24 * 60 * 60 * 1000);

  return withFallback(
    async () => {
      const rows = await prisma.billingAlert.findMany({
        where: {
          status: "resolved",
          resolvedAt: { gte: from },
        },
        select: {
          createdAt: true,
          resolvedAt: true,
        },
      });

      const durations = rows
        .filter((row) => row.createdAt && row.resolvedAt)
        .map((row) => row.resolvedAt.getTime() - row.createdAt.getTime())
        .filter((ms) => ms >= 0);

      if (durations.length === 0) {
        return { mttrHours: 0, resolvedCount: 0 };
      }

      const avgMs = durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
      return {
        mttrHours: Number((avgMs / (1000 * 60 * 60)).toFixed(2)),
        resolvedCount: durations.length,
      };
    },
    () => {
      const durations = memory.billingAlerts
        .filter((a) => {
          if (a.status !== "resolved" || !a.resolvedAt) {
            return false;
          }
          return new Date(a.resolvedAt) >= from;
        })
        .map((a) => new Date(a.resolvedAt).getTime() - new Date(a.createdAt).getTime())
        .filter((ms) => ms >= 0);

      if (durations.length === 0) {
        return { mttrHours: 0, resolvedCount: 0 };
      }

      const avgMs = durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
      return {
        mttrHours: Number((avgMs / (1000 * 60 * 60)).toFixed(2)),
        resolvedCount: durations.length,
      };
    }
  );
}

async function resolveBillingAlert(alertId) {
  const id = String(alertId || "").trim();
  if (!id) {
    throw new Error("alertId is required");
  }

  return withFallback(
    async () => {
      return prisma.billingAlert.update({
        where: { id },
        data: {
          status: "resolved",
          resolvedAt: new Date(),
        },
      });
    },
    () => {
      const found = memory.billingAlerts.find((a) => a.id === id);
      if (!found) {
        throw new Error("Billing alert not found");
      }
      found.status = "resolved";
      found.resolvedAt = new Date().toISOString();
      return {
        ...found,
        createdAt: new Date(found.createdAt),
        resolvedAt: new Date(found.resolvedAt),
      };
    }
  );
}

async function resolveOpenBillingAlertsBySiteAndType(site, type, now = new Date()) {
  const safeSite = String(site || "").trim();
  const safeType = String(type || "").trim();
  if (!safeSite || !safeType) {
    return 0;
  }

  return withFallback(
    async () => {
      const result = await prisma.billingAlert.updateMany({
        where: {
          site: safeSite,
          type: safeType,
          status: "open",
        },
        data: {
          status: "resolved",
          resolvedAt: now,
        },
      });

      return result.count;
    },
    () => {
      const resolvedAt = now.toISOString();
      let updated = 0;

      for (const alert of memory.billingAlerts) {
        if (alert.site !== safeSite || alert.type !== safeType || alert.status !== "open") {
          continue;
        }
        alert.status = "resolved";
        alert.resolvedAt = resolvedAt;
        updated += 1;
      }

      return updated;
    }
  );
}

function toCriticalMessage(message) {
  const current = String(message || "").trim();
  if (current.includes("[CRITICO]")) {
    return current;
  }
  return `[CRITICO] ${current}`;
}

async function runBillingAlertEscalation(now = new Date()) {
  return withFallback(
    async () => {
      const openAlerts = await prisma.billingAlert.findMany({
        where: {
          status: "open",
          type: "payment_failed",
        },
      });

      let escalatedCount = 0;
      const escalatedAlerts = [];
      for (const alert of openAlerts) {
        const shop = await prisma.shop.findUnique({
          where: { site: alert.site },
          select: { billingStatus: true, gracePeriodEndsAt: true },
        });

        const isExpired = Boolean(
          shop &&
            shop.billingStatus === "past_due" &&
            shop.gracePeriodEndsAt &&
            shop.gracePeriodEndsAt <= now
        );

        if (!isExpired) {
          continue;
        }

        if (alert.severity === "critical" && String(alert.message || "").includes("[CRITICO]")) {
          continue;
        }

        await prisma.billingAlert.update({
          where: { id: alert.id },
          data: {
            severity: "critical",
            message: toCriticalMessage(alert.message),
          },
        });
        escalatedCount += 1;
        escalatedAlerts.push({
          id: alert.id,
          site: alert.site,
          type: alert.type,
          message: toCriticalMessage(alert.message),
        });
      }

      return { escalatedCount, escalatedAlerts };
    },
    () => {
      let escalatedCount = 0;
      const escalatedAlerts = [];
      for (const alert of memory.billingAlerts) {
        if (alert.status !== "open" || alert.type !== "payment_failed") {
          continue;
        }

        const billing = memory.billingBySite[alert.site];
        const grace = billing?.gracePeriodEndsAt ? new Date(billing.gracePeriodEndsAt) : null;
        const isExpired = Boolean(
          billing &&
            billing.billingStatus === "past_due" &&
            grace &&
            grace <= now
        );

        if (!isExpired) {
          continue;
        }

        if (alert.severity === "critical" && String(alert.message || "").includes("[CRITICO]")) {
          continue;
        }

        alert.severity = "critical";
        alert.message = toCriticalMessage(alert.message);
        escalatedCount += 1;
        escalatedAlerts.push({
          id: alert.id,
          site: alert.site,
          type: alert.type,
          message: alert.message,
        });
      }

      return { escalatedCount, escalatedAlerts };
    }
  );
}

async function hasProcessedBillingWebhookEvent(provider, eventId) {
  const safeProvider = String(provider || "").trim();
  const safeEventId = String(eventId || "").trim();
  if (!safeProvider || !safeEventId) {
    return false;
  }

  return withFallback(
    async () => {
      const row = await prisma.billingWebhookEvent.findUnique({
        where: {
          provider_eventId: {
            provider: safeProvider,
            eventId: safeEventId,
          },
        },
      });
      return Boolean(row);
    },
    () => memory.billingWebhookEvents.has(`${safeProvider}:${safeEventId}`)
  );
}

async function markBillingWebhookEventProcessed(provider, eventId) {
  const safeProvider = String(provider || "").trim();
  const safeEventId = String(eventId || "").trim();
  if (!safeProvider || !safeEventId) {
    return false;
  }

  return withFallback(
    async () => {
      await prisma.billingWebhookEvent.upsert({
        where: {
          provider_eventId: {
            provider: safeProvider,
            eventId: safeEventId,
          },
        },
        update: {},
        create: {
          provider: safeProvider,
          eventId: safeEventId,
        },
      });
      return true;
    },
    () => {
      memory.billingWebhookEvents.add(`${safeProvider}:${safeEventId}`);
      return true;
    }
  );
}

function normalizePlan(value) {
  const plan = String(value || "").toLowerCase();
  if (plan === "starter" || plan === "pro") {
    return plan;
  }
  return "free";
}

function normalizeBillingStatus(value) {
  const status = String(value || "").toLowerCase();
  const allowed = [
    "active",
    "trialing",
    "past_due",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "unpaid",
  ];
  if (allowed.includes(status)) {
    return status;
  }
  return "free";
}

function formatBillingMeta(raw) {
  if (!raw) {
    return {
      plan: "free",
      billingStatus: "free",
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      currentPeriodEnd: null,
      gracePeriodEndsAt: null,
    };
  }

  return {
    plan: normalizePlan(raw.plan),
    billingStatus: normalizeBillingStatus(raw.billingStatus),
    stripeCustomerId: String(raw.stripeCustomerId || ""),
    stripeSubscriptionId: String(raw.stripeSubscriptionId || ""),
    currentPeriodEnd: raw.currentPeriodEnd ? new Date(raw.currentPeriodEnd).toISOString() : null,
    gracePeriodEndsAt: raw.gracePeriodEndsAt ? new Date(raw.gracePeriodEndsAt).toISOString() : null,
  };
}

async function upsertSiteBilling(site, billingMeta = {}) {
  const cleanSite = String(site || "").trim();
  if (!cleanSite) {
    throw new Error("site is required");
  }

  return withFallback(
    async () => {
      const next = formatBillingMeta(billingMeta);
      const updated = await prisma.shop.upsert({
        where: { site: cleanSite },
        update: {
          plan: next.plan,
          billingStatus: next.billingStatus,
          stripeCustomerId: next.stripeCustomerId || null,
          stripeSubscriptionId: next.stripeSubscriptionId || null,
          currentPeriodEnd: next.currentPeriodEnd ? new Date(next.currentPeriodEnd) : null,
          gracePeriodEndsAt: next.gracePeriodEndsAt ? new Date(next.gracePeriodEndsAt) : null,
        },
        create: {
          site: cleanSite,
          plan: next.plan,
          billingStatus: next.billingStatus,
          stripeCustomerId: next.stripeCustomerId || null,
          stripeSubscriptionId: next.stripeSubscriptionId || null,
          currentPeriodEnd: next.currentPeriodEnd ? new Date(next.currentPeriodEnd) : null,
          gracePeriodEndsAt: next.gracePeriodEndsAt ? new Date(next.gracePeriodEndsAt) : null,
        },
      });

      return {
        site: updated.site,
        plan: normalizePlan(updated.plan),
        billingStatus: normalizeBillingStatus(updated.billingStatus),
        stripeCustomerId: String(updated.stripeCustomerId || ""),
        stripeSubscriptionId: String(updated.stripeSubscriptionId || ""),
        currentPeriodEnd: updated.currentPeriodEnd ? updated.currentPeriodEnd.toISOString() : null,
        gracePeriodEndsAt: updated.gracePeriodEndsAt ? updated.gracePeriodEndsAt.toISOString() : null,
      };
    },
    () => {
      const next = formatBillingMeta(billingMeta);
      memory.billingBySite[cleanSite] = next;
      return { site: cleanSite, ...next };
    }
  );
}

async function getSiteBilling(site) {
  const cleanSite = String(site || "").trim();
  if (!cleanSite) {
    return formatBillingMeta(null);
  }

  return withFallback(
    async () => {
      const row = await prisma.shop.findUnique({
        where: { site: cleanSite },
        select: {
          plan: true,
          billingStatus: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          currentPeriodEnd: true,
          gracePeriodEndsAt: true,
        },
      });

      return formatBillingMeta(row);
    },
    () => formatBillingMeta(memory.billingBySite[cleanSite])
  );
}

async function findShopByStripeCustomerId(stripeCustomerId) {
  const customerId = String(stripeCustomerId || "").trim();
  if (!customerId) {
    return null;
  }

  return withFallback(
    async () => {
      const row = await prisma.shop.findFirst({
        where: { stripeCustomerId: customerId },
      });
      return row || null;
    },
    () => {
      const site = Object.keys(memory.billingBySite).find(
        (key) => String(memory.billingBySite[key]?.stripeCustomerId || "") === customerId
      );
      if (!site) {
        return null;
      }
      return memory.shops.find((s) => s.site === site) || null;
    }
  );
}

async function findShopByStripeSubscriptionId(stripeSubscriptionId) {
  const subscriptionId = String(stripeSubscriptionId || "").trim();
  if (!subscriptionId) {
    return null;
  }

  return withFallback(
    async () => {
      const row = await prisma.shop.findFirst({
        where: { stripeSubscriptionId: subscriptionId },
      });
      return row || null;
    },
    () => {
      const site = Object.keys(memory.billingBySite).find(
        (key) => String(memory.billingBySite[key]?.stripeSubscriptionId || "") === subscriptionId
      );
      if (!site) {
        return null;
      }
      return memory.shops.find((s) => s.site === site) || null;
    }
  );
}

async function withFallback(dbCall, fallbackCall) {
  if (isFallbackEnabled()) {
    return fallbackCall();
  }

  try {
    return await dbCall();
  } catch (error) {
    throw error;
  }
}

function mapEvent(row) {
  return {
    timestamp: row.timestamp.toISOString(),
    site: row.site,
    category: row.category,
    action: row.action,
    country: row.country,
    subjectId: row.subjectId || null,
  };
}

function mapMemoryEvent(row) {
  return {
    timestamp: new Date(row.timestamp).toISOString(),
    site: row.site,
    category: row.category,
    action: row.action,
    country: row.country,
    subjectId: row.subjectId || null,
  };
}

function mapMemoryShop(row) {
  const billing = formatBillingMeta(memory.billingBySite[row.site]);
  return {
    id: row.id,
    site: row.site,
    country: row.country,
    retentionDays: row.retentionDays,
    createdAt: new Date(row.createdAt),
    plan: billing.plan,
    billingStatus: billing.billingStatus,
    currentPeriodEnd: billing.currentPeriodEnd,
  };
}

function resolveDefaultCountryCode() {
  const candidate = String(process.env.DEFAULT_COUNTRY_CODE || "CL").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(candidate) ? candidate : "CL";
}

async function addEvent(event) {
  const normalizedCountry = String(event.country || "").trim().toUpperCase() || resolveDefaultCountryCode();
  const subjectId = String(event.subjectId || "").trim() || null;

  return withFallback(
    async () => {
      const shop = await prisma.shop.upsert({
        where: { site: event.site },
        update: {
          country: normalizedCountry,
        },
        create: {
          site: event.site,
          country: normalizedCountry,
        },
      });

      return prisma.consentEvent.create({
        data: {
          shopId: shop.id,
          site: event.site,
          category: event.category,
          action: event.action,
          country: normalizedCountry,
          subjectId,
        },
      });
    },
    () => {
      let shop = memory.shops.find((s) => s.site === event.site);
      if (!shop) {
        shop = {
          id: `shop_${memory.shops.length + 1}`,
          site: event.site,
          country: normalizedCountry,
          retentionDays: 90,
          createdAt: new Date().toISOString(),
        };
        memory.shops.push(shop);
      } else {
        shop.country = normalizedCountry || shop.country;
      }

      const newEvent = {
        id: `evt_${memory.events.length + 1}`,
        timestamp: new Date().toISOString(),
        shopId: shop.id,
        site: event.site,
        category: event.category,
        action: event.action,
        country: normalizedCountry,
        subjectId,
      };
      memory.events.push(newEvent);
      return {
        ...newEvent,
        timestamp: new Date(newEvent.timestamp),
      };
    }
  );
}

async function findShopBySite(siteInput) {
  const site = String(siteInput || "").trim().toLowerCase();
  if (!site) {
    return null;
  }

  return withFallback(
    async () => {
      const row = await prisma.shop.findUnique({ where: { site } });
      if (!row) {
        return null;
      }
      return {
        ...row,
        plan: normalizePlan(row.plan),
        billingStatus: normalizeBillingStatus(row.billingStatus),
        currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
        gracePeriodEndsAt: row.gracePeriodEndsAt ? row.gracePeriodEndsAt.toISOString() : null,
      };
    },
    () => {
      const row = memory.shops.find((shop) => String(shop.site || "").toLowerCase() === site);
      if (!row) {
        return null;
      }
      return mapMemoryShop(row);
    }
  );
}

async function createShopOnboarding(input = {}) {
  const site = String(input.site || "").trim().toLowerCase();
  const country = String(input.country || "").trim().toUpperCase() || resolveDefaultCountryCode();
  const plan = normalizePlan(input.plan || "free");
  const billingStatus = normalizeBillingStatus(input.billingStatus || "inactive");

  if (!site) {
    throw new Error("site is required");
  }

  return withFallback(
    async () => {
      const row = await prisma.shop.upsert({
        where: { site },
        update: {
          country,
          plan,
          billingStatus,
        },
        create: {
          site,
          country,
          plan,
          billingStatus,
        },
      });

      return {
        ...row,
        plan: normalizePlan(row.plan),
        billingStatus: normalizeBillingStatus(row.billingStatus),
        currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
        gracePeriodEndsAt: row.gracePeriodEndsAt ? row.gracePeriodEndsAt.toISOString() : null,
      };
    },
    () => {
      let found = memory.shops.find((shop) => shop.site === site);
      if (!found) {
        found = {
          id: `shop_${memory.shops.length + 1}`,
          site,
          country,
          retentionDays: 90,
          createdAt: new Date().toISOString(),
        };
        memory.shops.push(found);
      } else {
        found.country = country;
      }

      const currentBilling = formatBillingMeta(memory.billingBySite[site]);
      memory.billingBySite[site] = {
        ...currentBilling,
        plan,
        billingStatus,
      };

      return mapMemoryShop(found);
    }
  );
}

async function listEventsBySite(site, options = {}) {
  const fromDate = options.fromDate || null;
  const historyDays = Number(options.historyDays || 0);
  const historyFloor = Number.isFinite(historyDays) && historyDays > 0
    ? new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000)
    : null;
  const effectiveFromDate = fromDate && historyFloor
    ? new Date(Math.max(new Date(fromDate).getTime(), historyFloor.getTime()))
    : (fromDate || historyFloor);

  return withFallback(
    async () => {
      const rows = await prisma.consentEvent.findMany({
        where: {
          site,
          ...(effectiveFromDate ? { timestamp: { gte: effectiveFromDate } } : {}),
        },
        orderBy: { timestamp: "desc" },
      });

      return rows.map(mapEvent);
    },
    () => {
      return memory.events
        .filter((evt) => {
          if (evt.site !== site) {
            return false;
          }
          if (effectiveFromDate && new Date(evt.timestamp) < effectiveFromDate) {
            return false;
          }
          return true;
        })
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .map(mapMemoryEvent);
    }
  );
}

async function countEventsBySiteSince(site, fromDate) {
  return withFallback(
    async () => {
      return prisma.consentEvent.count({
        where: {
          site,
          ...(fromDate ? { timestamp: { gte: fromDate } } : {}),
        },
      });
    },
    () => {
      return memory.events.filter((evt) => {
        if (evt.site !== site) {
          return false;
        }
        if (fromDate && new Date(evt.timestamp) < fromDate) {
          return false;
        }
        return true;
      }).length;
    }
  );
}

async function getMonthlyUsageBySite(site, days = 30) {
  const from = new Date(Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000);
  const used = await countEventsBySiteSince(site, from);
  return {
    site,
    used,
    from,
  };
}

async function getMonthlyUsageBySites(sites = [], days = 30) {
  const normalizedSites = [...new Set((Array.isArray(sites) ? sites : [])
    .map((site) => String(site || "").trim().toLowerCase())
    .filter(Boolean))];

  const from = new Date(Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000);
  if (normalizedSites.length === 0) {
    return {};
  }

  return withFallback(
    async () => {
      const rows = await prisma.consentEvent.groupBy({
        by: ["site"],
        where: {
          site: { in: normalizedSites },
          timestamp: { gte: from },
        },
        _count: {
          _all: true,
        },
      });

      const usage = {};
      for (const site of normalizedSites) {
        usage[site] = 0;
      }
      for (const row of rows) {
        usage[String(row.site)] = Number(row._count?._all || 0);
      }
      return usage;
    },
    () => {
      const usage = {};
      for (const site of normalizedSites) {
        usage[site] = 0;
      }

      for (const evt of memory.events) {
        const site = String(evt.site || "").trim().toLowerCase();
        if (!usage.hasOwnProperty(site)) {
          continue;
        }
        if (new Date(evt.timestamp) < from) {
          continue;
        }
        usage[site] += 1;
      }

      return usage;
    }
  );
}

async function listShops() {
  return withFallback(
    async () => {
      const rows = await prisma.shop.findMany({
        orderBy: { createdAt: "desc" },
      });

      return rows.map((row) => ({
        ...row,
        plan: normalizePlan(row.plan),
        billingStatus: normalizeBillingStatus(row.billingStatus),
        currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
        gracePeriodEndsAt: row.gracePeriodEndsAt ? row.gracePeriodEndsAt.toISOString() : null,
      }));
    },
    () => {
      return [...memory.shops]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(mapMemoryShop);
    }
  );
}

async function listEventsBySiteAndSubject(siteInput, subjectIdInput, options = {}) {
  const site = String(siteInput || "").trim().toLowerCase();
  const subjectId = String(subjectIdInput || "").trim();
  if (!site || !subjectId) {
    return [];
  }

  const all = await listEventsBySite(site, options);
  return all.filter((event) => String(event.subjectId || "").trim() === subjectId);
}

async function deleteEventsBySiteAndSubject(siteInput, subjectIdInput, options = {}) {
  const site = String(siteInput || "").trim().toLowerCase();
  const subjectId = String(subjectIdInput || "").trim();
  const beforeDate = options.beforeDate ? new Date(options.beforeDate) : null;
  if (!site || !subjectId) {
    return { deletedCount: 0 };
  }

  return withFallback(
    async () => {
      const where = {
        site,
        subjectId,
      };
      if (beforeDate && !Number.isNaN(beforeDate.getTime())) {
        where.timestamp = { lte: beforeDate };
      }

      const result = await prisma.consentEvent.deleteMany({ where });
      return { deletedCount: Number(result.count || 0) };
    },
    () => {
      const before = memory.events.length;
      memory.events = memory.events.filter((evt) => {
        if (String(evt.site || "").toLowerCase() !== site) {
          return true;
        }
        if (String(evt.subjectId || "").trim() !== subjectId) {
          return true;
        }
        if (beforeDate && !Number.isNaN(beforeDate.getTime()) && new Date(evt.timestamp) > beforeDate) {
          return true;
        }
        return false;
      });
      return { deletedCount: before - memory.events.length };
    }
  );
}

async function listRecentEvents(filters = {}) {
  const where = {};

  if (filters.site) {
    where.site = filters.site;
  }

  if (filters.from || filters.to) {
    where.timestamp = {};
    if (filters.from) {
      where.timestamp.gte = filters.from;
    }
    if (filters.to) {
      where.timestamp.lte = filters.to;
    }
  }

  const limit = Number(filters.limit || 50);
  return withFallback(
    async () => {
      const rows = await prisma.consentEvent.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take: limit,
      });

      return rows.map(mapEvent);
    },
    () => {
      return memory.events
        .filter((evt) => {
          if (filters.site && evt.site !== filters.site) {
            return false;
          }
          const t = new Date(evt.timestamp);
          if (filters.from && t < filters.from) {
            return false;
          }
          if (filters.to && t > filters.to) {
            return false;
          }
          return true;
        })
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limit)
        .map(mapMemoryEvent);
    }
  );
}

async function getDashboardStats(filters = {}) {
  const eventsWhere = {};
  if (filters.site) {
    eventsWhere.site = filters.site;
  }
  if (filters.from || filters.to) {
    eventsWhere.timestamp = {};
    if (filters.from) {
      eventsWhere.timestamp.gte = filters.from;
    }
    if (filters.to) {
      eventsWhere.timestamp.lte = filters.to;
    }
  }

  return withFallback(
    async () => {
      const [shopsCount, eventsCount] = await Promise.all([
        prisma.shop.count(),
        prisma.consentEvent.count({ where: eventsWhere }),
      ]);

      return {
        shopsCount,
        eventsCount,
      };
    },
    () => {
      const events = memory.events.filter((evt) => {
        if (filters.site && evt.site !== filters.site) {
          return false;
        }
        const t = new Date(evt.timestamp);
        if (filters.from && t < filters.from) {
          return false;
        }
        if (filters.to && t > filters.to) {
          return false;
        }
        return true;
      });

      return {
        shopsCount: memory.shops.length,
        eventsCount: events.length,
      };
    }
  );
}

function buildEventWhere(filters = {}) {
  const where = {};

  if (filters.site) {
    where.site = filters.site;
  }

  if (filters.from || filters.to) {
    where.timestamp = {};
    if (filters.from) {
      where.timestamp.gte = filters.from;
    }
    if (filters.to) {
      where.timestamp.lte = filters.to;
    }
  }

  return where;
}

async function getActionBreakdown(filters = {}) {
  return withFallback(
    async () => {
      const where = buildEventWhere(filters);
      const rows = await prisma.consentEvent.groupBy({
        by: ["action"],
        where,
        _count: { _all: true },
      });

      return rows.reduce((acc, row) => {
        acc[row.action] = row._count._all;
        return acc;
      }, {});
    },
    () => {
      const result = {};
      for (const evt of memory.events) {
        if (filters.site && evt.site !== filters.site) {
          continue;
        }
        const t = new Date(evt.timestamp);
        if (filters.from && t < filters.from) {
          continue;
        }
        if (filters.to && t > filters.to) {
          continue;
        }
        result[evt.action] = (result[evt.action] || 0) + 1;
      }
      return result;
    }
  );
}

async function getCategoryBreakdown(filters = {}) {
  return withFallback(
    async () => {
      const where = buildEventWhere(filters);
      const rows = await prisma.consentEvent.groupBy({
        by: ["category"],
        where,
        _count: { _all: true },
      });

      return rows.reduce((acc, row) => {
        acc[row.category] = row._count._all;
        return acc;
      }, {});
    },
    () => {
      const result = {};
      for (const evt of memory.events) {
        if (filters.site && evt.site !== filters.site) {
          continue;
        }
        const t = new Date(evt.timestamp);
        if (filters.from && t < filters.from) {
          continue;
        }
        if (filters.to && t > filters.to) {
          continue;
        }
        result[evt.category] = (result[evt.category] || 0) + 1;
      }
      return result;
    }
  );
}

async function updateShopRetentionDays(site, retentionDays) {
  return withFallback(
    async () => {
      return prisma.shop.update({
        where: { site },
        data: { retentionDays },
      });
    },
    () => {
      const shop = memory.shops.find((s) => s.site === site);
      if (!shop) {
        throw new Error("Shop not found");
      }
      shop.retentionDays = retentionDays;
      return mapMemoryShop(shop);
    }
  );
}

async function runRetentionCleanup(now = new Date()) {
  return withFallback(
    async () => {
      const shops = await prisma.shop.findMany({
        select: { id: true, retentionDays: true, site: true },
      });

      let deletedTotal = 0;
      const bySite = [];

      for (const shop of shops) {
        const cutoff = new Date(now.getTime() - shop.retentionDays * 24 * 60 * 60 * 1000);
        const result = await prisma.consentEvent.deleteMany({
          where: {
            shopId: shop.id,
            timestamp: { lt: cutoff },
          },
        });

        deletedTotal += result.count;
        bySite.push({ site: shop.site, deleted: result.count, retentionDays: shop.retentionDays });
      }

      return { deletedTotal, bySite };
    },
    () => {
      let deletedTotal = 0;
      const bySite = [];

      for (const shop of memory.shops) {
        const cutoff = new Date(now.getTime() - shop.retentionDays * 24 * 60 * 60 * 1000);
        const before = memory.events.length;
        memory.events = memory.events.filter((evt) => {
          if (evt.shopId !== shop.id) {
            return true;
          }
          return new Date(evt.timestamp) >= cutoff;
        });
        const deleted = before - memory.events.length;
        deletedTotal += deleted;
        bySite.push({ site: shop.site, deleted, retentionDays: shop.retentionDays });
      }

      return { deletedTotal, bySite };
    }
  );
}

module.exports = {
  consumeRateLimitBucket,
  purgeExpiredRateLimitBuckets,
  saveMagicLinkToken,
  consumeMagicLinkToken,
  purgeExpiredMagicLinkTokens,
  createApiCredential,
  findActiveApiCredentialByKey,
  findApiCredentialById,
  touchApiCredentialLastUsed,
  listApiCredentials,
  revokeApiCredential,
  addEvent,
  findShopBySite,
  createShopOnboarding,
  listEventsBySite,
  listEventsBySiteAndSubject,
  deleteEventsBySiteAndSubject,
  countEventsBySiteSince,
  getMonthlyUsageBySite,
  getMonthlyUsageBySites,
  findShopByStripeCustomerId,
  findShopByStripeSubscriptionId,
  listShops,
  listRecentEvents,
  getDashboardStats,
  getActionBreakdown,
  getCategoryBreakdown,
  updateShopRetentionDays,
  runRetentionCleanup,
  upsertSiteBilling,
  getSiteBilling,
  createBillingAlert,
  listOpenBillingAlerts,
  listRecentBillingIncidents,
  getCriticalAlertsEligibleForEmail,
  markCriticalAlertsEmailSent,
  getBillingMttrHours,
  resolveBillingAlert,
  resolveOpenBillingAlertsBySiteAndType,
  runBillingAlertEscalation,
  createAuditLog,
  listAuditLogs,
  listAuditLogsPage,
  encodeAuditCursor,
  isValidAuditCursor,
  hasProcessedBillingWebhookEvent,
  markBillingWebhookEventProcessed,
  upsertDashboardAccessPolicy,
  listDashboardAccessPolicies,
  findDashboardAccessPolicyByEmail,
  deleteDashboardAccessPolicyByEmail,
  resetStoreForTests,
};
