# Stripe Webhook Event Matrix (Ticket CH-BILL-006)

Fecha: 2026-04-08

Objetivo: definir comportamiento esperado por evento y enlazar su cobertura de pruebas para evitar huecos funcionales en billing.

## Matriz

| Evento Stripe | Comportamiento esperado | Estado | Cobertura actual |
| --- | --- | --- | --- |
| `checkout.session.completed` | Si `metadata.site` y `metadata.plan` valido (`starter|pro`), activar plan (`billingStatus=active`) y guardar customer/subscription IDs. Si plan `free` o sin site, no-op seguro. | DONE | `tests/billing-webhook-flow.test.js` (checkout valid/invalid + idempotencia) |
| `customer.subscription.created` | Resolver sitio (metadata o fallback), resolver plan (metadata o nickname), persistir estado y period end. Si `past_due`, asignar `gracePeriodEndsAt`. | DONE | `tests/billing-webhook-flow.test.js` (created active + created past_due) |
| `customer.subscription.updated` | Resolver sitio por metadata -> subscriptionId -> customerId. Actualizar plan/estado y limpiar o setear gracia segun estado. No-op si no hay sitio resoluble. | DONE | `tests/billing-webhook-flow.test.js` (fallbacks + transiciones + no-op) |
| `customer.subscription.deleted` | Downgrade a `plan=free`, `billingStatus=canceled`, limpiar periodos de gracia. | DONE | `tests/billing-webhook-flow.test.js` (deleted directo + fallback por customer) |
| `invoice.payment_failed` | Cambiar a `past_due`, setear gracia, crear alerta `payment_failed`. No-op seguro si customer no mapeado. | DONE | `tests/billing-webhook-flow.test.js` + `tests/billing-alerts.test.js` |
| `invoice.payment_succeeded` | Recuperar a `active`, limpiar gracia, cerrar alertas `payment_failed` abiertas. Ignorar reactivacion si estado actual es `canceled`. | DONE | `tests/billing-webhook-flow.test.js` |
| `invoice.paid` | Mismo flujo de recuperacion que `invoice.payment_succeeded` y cierre de alertas abiertas. | DONE | `tests/billing-webhook-flow.test.js` |

## Reglas transversales

- Idempotencia por `provider + eventId`:
  - duplicados responden `200` con `{ received: true, duplicate: true }`.
- Validacion de firma:
  - sin `stripe-signature` o firma invalida devuelve `400`.
- Evento no reconocido:
  - no-op seguro, pero se registra idempotencia del `eventId`.

## Fuente de verdad

- Implementacion: `src/routes/billing.js`
- Persistencia/alertas: `src/data/store.js`
- Pruebas de flujo: `tests/billing-webhook-flow.test.js`
- Pruebas de alertas: `tests/billing-alerts.test.js`
