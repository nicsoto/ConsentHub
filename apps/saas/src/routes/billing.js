const crypto = require("crypto");
const express = require("express");
const { requireDashboardSession, hasPermission, hasSiteAccess } = require("../middleware/dashboardAuth");
const { ensureCsrfCookie, requireCsrf } = require("../middleware/csrf");
const {
  upsertSiteBilling,
  getSiteBilling,
  createBillingAlert,
  resolveOpenBillingAlertsBySiteAndType,
  findShopByStripeCustomerId,
  findShopByStripeSubscriptionId,
  hasProcessedBillingWebhookEvent,
  markBillingWebhookEventProcessed,
} = require("../data/store");
const {
  getStripeClient,
  getPriceIdForPlan,
  hasStripeBillingConfig,
  stripeWebhookSecret,
} = require("../services/stripeClient");
const { sendPaymentFailedCustomerEmail } = require("../services/email");
const { appBaseUrl, billingGraceDays } = require("../config/env");

const billingRouter = express.Router();
const billingWebhookRouter = express.Router();

function normalizePlan(value) {
  const plan = String(value || "").toLowerCase();
  if (plan === "starter" || plan === "pro") {
    return plan;
  }
  return "free";
}

function extractSiteFromSubscription(subscription) {
  return String(subscription?.metadata?.site || subscription?.items?.data?.[0]?.price?.metadata?.site || "").trim();
}

async function resolveSiteByStripeObjects(subscription) {
  const byMetadata = extractSiteFromSubscription(subscription);
  if (byMetadata) {
    return byMetadata;
  }

  const bySubscriptionId = await findShopByStripeSubscriptionId(subscription?.id || "");
  if (bySubscriptionId?.site) {
    return bySubscriptionId.site;
  }

  const byCustomer = await findShopByStripeCustomerId(subscription?.customer || "");
  return byCustomer?.site || "";
}

function resolvePlanFromSubscription(subscription) {
  const metadataPlan = normalizePlan(subscription?.metadata?.plan);
  if (metadataPlan !== "free") {
    return metadataPlan;
  }

  const nickname = String(subscription?.items?.data?.[0]?.price?.nickname || "").toLowerCase();
  if (nickname.includes("starter")) {
    return "starter";
  }
  if (nickname.includes("pro")) {
    return "pro";
  }
  return "free";
}

billingWebhookRouter.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!hasStripeBillingConfig()) {
      return res.status(503).json({ error: "Stripe billing no esta configurado" });
    }

    const stripe = getStripeClient();
    const signature = req.headers["stripe-signature"];

    if (!stripe || !signature) {
      return res.status(400).json({ error: "Webhook invalido" });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
    } catch (error) {
      return res.status(400).json({ error: `Firma de webhook invalida: ${error.message}` });
    }

    try {
      const provider = "stripe";
      const eventId = String(event.id || "").trim();

      if (eventId) {
        const alreadyProcessed = await hasProcessedBillingWebhookEvent(provider, eventId);
        if (alreadyProcessed) {
          return res.status(200).json({ received: true, duplicate: true });
        }
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const site = String(session?.metadata?.site || "").trim();
        const plan = normalizePlan(session?.metadata?.plan);

        if (site && plan !== "free") {
          await upsertSiteBilling(site, {
            plan,
            billingStatus: "active",
            stripeCustomerId: session.customer || "",
            stripeSubscriptionId: session.subscription || "",
          });
        }
      }

      if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
        const subscription = event.data.object;
        const site = await resolveSiteByStripeObjects(subscription);
        const plan = resolvePlanFromSubscription(subscription);
        const periodEndSeconds = Number(subscription.current_period_end || 0);
        const status = String(subscription.status || "active").toLowerCase();

        if (site) {
          await upsertSiteBilling(site, {
            plan,
            billingStatus: status,
            stripeCustomerId: subscription.customer || "",
            stripeSubscriptionId: subscription.id || "",
            currentPeriodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000).toISOString() : null,
            gracePeriodEndsAt: status === "past_due"
              ? new Date(Date.now() + billingGraceDays * 24 * 60 * 60 * 1000).toISOString()
              : null,
          });

          if (status === "past_due") {
            console.warn(`[billing] ${site} entro en past_due; gracia ${billingGraceDays} dias`);
          }
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const site = await resolveSiteByStripeObjects(subscription);

        if (site) {
          await upsertSiteBilling(site, {
            plan: "free",
            billingStatus: "canceled",
            stripeCustomerId: subscription.customer || "",
            stripeSubscriptionId: subscription.id || "",
            currentPeriodEnd: null,
            gracePeriodEndsAt: null,
          });
        }
      }

      if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        const byCustomer = await findShopByStripeCustomerId(invoice?.customer || "");

        if (byCustomer?.site) {
          const current = await getSiteBilling(byCustomer.site);
          const graceEndsAt = new Date(Date.now() + billingGraceDays * 24 * 60 * 60 * 1000).toISOString();
          await upsertSiteBilling(byCustomer.site, {
            plan: current.plan || "free",
            billingStatus: "past_due",
            stripeCustomerId: invoice.customer || "",
            stripeSubscriptionId: invoice.subscription || "",
            currentPeriodEnd: null,
            gracePeriodEndsAt: graceEndsAt,
          });

          await createBillingAlert({
            site: byCustomer.site,
            type: "payment_failed",
            severity: "warning",
            rawEventId: eventId,
            message: `Pago fallido. El sitio entra en gracia hasta ${new Date(graceEndsAt).toLocaleDateString("es-CL")}.`,
          });

          const customerEmail = String(invoice?.customer_email || "").trim();
          if (customerEmail) {
            sendPaymentFailedCustomerEmail({
              to: customerEmail,
              site: byCustomer.site,
              graceEndsAt,
            }).catch((error) => {
              console.warn(`[billing] no se pudo enviar email a cliente ${byCustomer.site}: ${error.message}`);
            });
          }

          console.warn(`[billing] pago fallido para ${byCustomer.site}; gracia ${billingGraceDays} dias`);
        }
      }

      if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
        const invoice = event.data.object;
        const byCustomer = await findShopByStripeCustomerId(invoice?.customer || "");

        if (byCustomer?.site) {
          const current = await getSiteBilling(byCustomer.site);
          if (current.billingStatus === "canceled") {
            if (event.type === "invoice.payment_succeeded") {
              console.warn(`[billing] invoice.payment_succeeded ignorado para ${byCustomer.site} por estado canceled`);
            }
          } else {
            await upsertSiteBilling(byCustomer.site, {
              plan: current.plan || "free",
              billingStatus: "active",
              stripeCustomerId: invoice.customer || "",
              stripeSubscriptionId: invoice.subscription || current.stripeSubscriptionId || "",
              gracePeriodEndsAt: null,
            });

            await resolveOpenBillingAlertsBySiteAndType(byCustomer.site, "payment_failed");
          }
        }
      }

      if (eventId) {
        await markBillingWebhookEventProcessed(provider, eventId);
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "No fue posible procesar el webhook" });
    }
  }
);

billingRouter.use(ensureCsrfCookie);

billingRouter.get("/billing/status", requireDashboardSession, async (req, res) => {
  const site = String(req.query?.site || "").trim();
  if (!hasPermission(req.dashboardUser, "dashboard.view")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!hasSiteAccess(req.dashboardUser, site)) {
    return res.status(403).json({ error: "Sin acceso al sitio" });
  }
  if (!site) {
    return res.status(400).json({ error: "site es requerido" });
  }

  const status = await getSiteBilling(site);
  return res.status(200).json({ site, ...status, stripeConfigured: hasStripeBillingConfig() });
});

billingRouter.post("/billing/checkout", requireDashboardSession, requireCsrf, async (req, res) => {
  const site = String(req.body?.site || "").trim();
  const plan = normalizePlan(req.body?.plan);

  if (!hasPermission(req.dashboardUser, "dashboard.billing_alerts.write")) {
    return res.redirect("/dashboard-v2?flash=No+tienes+permiso+para+billing");
  }

  if (!hasSiteAccess(req.dashboardUser, site)) {
    return res.redirect("/dashboard-v2?flash=Sin+acceso+al+sitio");
  }

  if (!site || plan === "free") {
    return res.redirect("/dashboard-v2?flash=Plan+o+sitio+invalido");
  }

  if (!hasStripeBillingConfig()) {
    return res.redirect("/dashboard-v2?flash=Stripe+no+esta+configurado+aun");
  }

  const stripe = getStripeClient();
  const price = getPriceIdForPlan(plan);

  if (!stripe || !price) {
    return res.redirect("/dashboard-v2?flash=Config+de+precios+incompleta");
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      success_url: `${appBaseUrl}/dashboard-v2?flash=Checkout+completado`,
      cancel_url: `${appBaseUrl}/dashboard-v2?flash=Checkout+cancelado`,
      line_items: [
        {
          price,
          quantity: 1,
        },
      ],
      metadata: {
        site,
        plan,
        adminEmail: req.dashboardUser.email,
      },
      subscription_data: {
        metadata: {
          site,
          plan,
          adminEmail: req.dashboardUser.email,
        },
      },
      customer_email: req.dashboardUser.email,
      allow_promotion_codes: true,
    });

    return res.redirect(session.url);
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard-v2?flash=Error+creando+checkout+de+Stripe");
  }
});

billingRouter.post("/billing/portal", requireDashboardSession, requireCsrf, async (req, res) => {
  const site = String(req.body?.site || "").trim();

  if (!hasPermission(req.dashboardUser, "dashboard.billing_alerts.write")) {
    return res.redirect("/dashboard-v2?flash=No+tienes+permiso+para+billing");
  }

  if (!hasSiteAccess(req.dashboardUser, site)) {
    return res.redirect("/dashboard-v2?flash=Sin+acceso+al+sitio");
  }

  if (!site) {
    return res.redirect("/dashboard-v2?flash=Sitio+invalido+para+portal");
  }

  if (!hasStripeBillingConfig()) {
    return res.redirect("/dashboard-v2?flash=Stripe+no+esta+configurado+aun");
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return res.redirect("/dashboard-v2?flash=Stripe+no+disponible");
  }

  const billing = await getSiteBilling(site);
  if (!billing.stripeCustomerId) {
    return res.redirect("/dashboard-v2?flash=El+sitio+no+tiene+cliente+Stripe+asociado");
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: `${appBaseUrl}/dashboard-v2?flash=Portal+cerrado`,
    });

    return res.redirect(session.url);
  } catch (error) {
    console.error(error);
    return res.redirect("/dashboard-v2?flash=No+se+pudo+abrir+el+portal+de+cliente");
  }
});

billingRouter.post("/billing/mock-upgrade", requireDashboardSession, requireCsrf, async (req, res) => {
  if (!hasPermission(req.dashboardUser, "dashboard.billing_alerts.write")) {
    return res.redirect("/dashboard-v2?flash=No+tienes+permiso+para+billing");
  }

  if (process.env.NODE_ENV === "production") {
    return res.redirect("/dashboard-v2?flash=Ruta+solo+disponible+en+desarrollo");
  }

  const site = String(req.body?.site || "").trim();
  const plan = normalizePlan(req.body?.plan);

  if (!hasSiteAccess(req.dashboardUser, site)) {
    return res.redirect("/dashboard-v2?flash=Sin+acceso+al+sitio");
  }

  if (!site || plan === "free") {
    return res.redirect("/dashboard-v2?flash=Plan+o+sitio+invalido");
  }

  await upsertSiteBilling(site, {
    plan,
    billingStatus: "active",
    stripeCustomerId: `mock_cus_${crypto.randomBytes(4).toString("hex")}`,
    stripeSubscriptionId: `mock_sub_${crypto.randomBytes(4).toString("hex")}`,
  });

  return res.redirect(`/dashboard-v2?flash=Plan+${plan}+activado+en+modo+mock+para+${encodeURIComponent(site)}`);
});

module.exports = {
  billingRouter,
  billingWebhookRouter,
};
