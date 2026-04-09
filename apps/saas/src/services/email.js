const { resendApiKey, emailFrom, appBaseUrl, allowedAdminEmails, supportEmail } = require("../config/env");

async function sendWithResend(to, subject, html) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom,
      to,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Resend request failed (${response.status}): ${details}`);
  }
}

async function sendMagicLinkEmail(email, link) {
  const subject = "Tu acceso a ConsentHub Dashboard";
  const html = `
    <div style="font-family: system-ui, sans-serif; line-height: 1.5; color: #0f172a;">
      <h2>Acceso a ConsentHub Dashboard</h2>
      <p>Usa este enlace para iniciar sesion. Expira en 15 minutos.</p>
      <p><a href="${link}" style="background:#2563eb;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;display:inline-block;">Entrar al dashboard</a></p>
      <p>Si no solicitaste este correo, puedes ignorarlo.</p>
      <p style="color:#64748b;font-size:12px;">${appBaseUrl}</p>
    </div>
  `;

  if (!resendApiKey || !emailFrom) {
    return {
      sent: false,
      provider: "none",
      reason: "missing_resend_config",
    };
  }

  await sendWithResend(email, subject, html);
  return {
    sent: true,
    provider: "resend",
  };
}

async function sendCriticalBillingAlertsEmail(alerts = []) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return { sent: false, provider: "none", reason: "no_alerts" };
  }

  if (!resendApiKey || !emailFrom || !allowedAdminEmails.length) {
    return {
      sent: false,
      provider: "none",
      reason: "missing_email_config_or_admin_recipients",
    };
  }

  const items = alerts
    .map((alert) => `<li><strong>${String(alert.site || "n/a")}</strong>: ${String(alert.message || "")}</li>`)
    .join("");

  const subject = `[ConsentHub] Alertas criticas de facturacion (${alerts.length})`;
  const html = `
    <div style="font-family: system-ui, sans-serif; line-height: 1.5; color: #0f172a;">
      <h2>Alertas criticas de facturacion</h2>
      <p>Se detectaron alertas con gracia vencida que requieren accion.</p>
      <ul>${items}</ul>
      <p>Revisa el dashboard para seguimiento y resolucion.</p>
      <p style="color:#64748b;font-size:12px;">${appBaseUrl}/dashboard</p>
    </div>
  `;

  await sendWithResend(allowedAdminEmails, subject, html);
  return {
    sent: true,
    provider: "resend",
    recipients: allowedAdminEmails.length,
  };
}

async function sendPaymentFailedCustomerEmail(input = {}) {
  const to = String(input.to || "").trim().toLowerCase();
  const site = String(input.site || "").trim();
  const graceEndsAt = input.graceEndsAt ? new Date(input.graceEndsAt) : null;

  if (!to || !site) {
    return { sent: false, provider: "none", reason: "missing_recipient_or_site" };
  }

  if (!resendApiKey || !emailFrom) {
    return { sent: false, provider: "none", reason: "missing_email_config" };
  }

  const graceText = graceEndsAt && !Number.isNaN(graceEndsAt.getTime())
    ? graceEndsAt.toLocaleDateString("es-CL")
    : "lo antes posible";

  const subject = `[ConsentHub] Problema de pago en ${site}`;
  const html = `
    <div style="font-family: system-ui, sans-serif; line-height: 1.5; color: #0f172a;">
      <h2>Tu pago no pudo procesarse</h2>
      <p>Detectamos un problema con el cobro de tu plan para <strong>${site}</strong>.</p>
      <p>Tu servicio esta en periodo de gracia hasta <strong>${graceText}</strong>.</p>
      <p>Te recomendamos actualizar tu metodo de pago en el portal de facturacion.</p>
      <p style="margin-top: 14px;">
        <a href="${appBaseUrl}/dashboard-v2" style="background:#2563eb;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;display:inline-block;">Ir al dashboard</a>
      </p>
      <p style="color:#64748b;font-size:12px;">Si ya regularizaste el pago, puedes ignorar este mensaje.</p>
    </div>
  `;

  await sendWithResend(to, subject, html);
  return {
    sent: true,
    provider: "resend",
    recipients: 1,
  };
}

async function sendOnboardingWelcomeEmail(input = {}) {
  const to = String(input.to || "").trim().toLowerCase();
  const site = String(input.site || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  const plan = String(input.plan || "free").trim().toLowerCase();

  if (!to || !site || !apiKey) {
    return { sent: false, provider: "none", reason: "missing_recipient_site_or_key" };
  }

  if (!resendApiKey || !emailFrom) {
    return { sent: false, provider: "none", reason: "missing_email_config" };
  }

  const subject = `[ConsentHub] Bienvenido: ${site} ya esta activo`;
  const html = `
    <div style="font-family: system-ui, sans-serif; line-height: 1.5; color: #0f172a;">
      <h2>Tu cuenta de ConsentHub esta lista</h2>
      <p>Se creo el sitio <strong>${site}</strong> con plan <strong>${plan}</strong>.</p>
      <p><strong>API Key inicial:</strong></p>
      <p style="padding:10px; border:1px solid #cbd5e1; border-radius:8px; background:#f8fafc; word-break:break-all;">${apiKey}</p>
      <p>Pasos recomendados:</p>
      <ol>
        <li>Instala/configura el plugin usando esta key.</li>
        <li>Envia un evento de prueba desde tu sitio.</li>
        <li>Ingresa a tu portal para gestionar credenciales y revisar uso.</li>
      </ol>
      <p>
        <a href="${appBaseUrl}/docs/plugin-install" style="background:#1d4ed8;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;display:inline-block; margin-right: 8px;">Guia plugin</a>
        <a href="${appBaseUrl}/auth/login" style="background:#111827;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;display:inline-block;">Ingresar</a>
      </p>
      <p style="color:#64748b;font-size:12px;">Soporte: ${supportEmail}</p>
    </div>
  `;

  await sendWithResend(to, subject, html);
  return {
    sent: true,
    provider: "resend",
    recipients: 1,
  };
}

module.exports = {
  sendMagicLinkEmail,
  sendCriticalBillingAlertsEmail,
  sendPaymentFailedCustomerEmail,
  sendOnboardingWelcomeEmail,
};
