// ThreadDrop fulfillment queue — pushes submitted custom orders into
// fulfillment records via the store layer. The print-on-demand partner will
// consume this queue once its API credentials are connected; until then the
// records wait here and are visible on the owner dashboard.
//
// Also hosts the phase 5c transactional-email hooks: the order-confirmation
// email fires when a paid order is pushed into the queue, the
// production-started email fires when the owner fulfills via Printful. Both
// are best-effort: a delivery failure is logged and NEVER fails the business
// operation that triggered it.
//
// Server-side only (imports the store module).

import { store, type CustomOrder, type FulfillmentItem } from "~/lib/store";
import { sendOrderConfirmation, sendProductionStarted } from "~/lib/mailer";

/** Custom orders with status 'submitted' that are not in the queue yet. */
export async function findQueueableOrders(): Promise<CustomOrder[]> {
  const [orders, items] = await Promise.all([
    store.listCustomOrders(),
    store.listFulfillmentItems(),
  ]);
  const alreadyQueued = new Set(items.map((i) => i.orderId));
  return orders.filter((o) => o.status === "submitted" && !alreadyQueued.has(o.id));
}

/**
 * Queue every 'submitted' custom order that isn't queued yet.
 * Returns the records actually created plus a snapshot of the whole queue.
 */
export async function queueSubmittedCustomOrders(): Promise<{
  queued: number;
  queuedAt: string;
  items: FulfillmentItem[];
}> {
  const orderIds = await findQueueableOrders();
  if (orderIds.length === 0) {
    return { queued: 0, queuedAt: new Date().toISOString(), items: [] };
  }
  const created = await store.createFulfillmentItems(
    orderIds.map((o) => ({
      orderId: o.id,
      type: "custom" as const,
      garment: o.garment,
      artworkUrl: o.artworkUrl,
      customerEmail: o.customerEmail,
      feeCents: o.feeCents,
    }))
  );
  const items = await store.listFulfillmentItems();
  const queuedAt = created[0]?.queuedAt ?? new Date().toISOString();
  // Phase 5c hook (a): these orders just became confirmed-for-production
  // (the server-side post-payment step of the hosted-checkout flow), so the
  // order-confirmation email fires here — once per order, guarded by the
  // confirmation_sent_at claim. Awaited so the queue response can report the
  // per-order email outcome without blocking on anything after it.
  const emails = await notifyOrderConfirmations(orderIds);
  return { queued: created.length, queuedAt, items, emails };
}

/**
 * Public origin for customer-facing links. PUBLIC_SITE_ORIGIN when set
 * (https only, trailing slashes trimmed), else the production site.
 */
function siteOrigin(): string {
  const envOrigin = process.env.PUBLIC_SITE_ORIGIN;
  if (envOrigin && /^https:\/\//.test(envOrigin)) return envOrigin.replace(/\/+$/, "");
  return "https://threaddrop.ctonew.app";
}

/**
 * Phase 5c hook (a): wherever a custom order transitions to paid/confirmed —
 * this queue push is the server-side post-payment step of the hosted-checkout
 * flow — fire the order-confirmation email once per order.
 *
 * Double-send guard: the atomic confirmation_sent_at claim — only the caller
 * whose UPDATE flips NULL -> now() sends; everyone else gets null and skips.
 * Never throws: a mail/config failure degrades to a per-order result and the
 * queue operation itself is unaffected.
 */
export async function notifyOrderConfirmations(
  orders: CustomOrder[]
): Promise<Array<{ orderId: string; delivery: string; reason?: string }>> {
  const results: Array<{ orderId: string; delivery: string; reason?: string }> = [];
  for (const order of orders) {
    const email = order.customerEmail?.trim();
    // No email on file → nothing to send; leave the guard unset so a later
    // run can still notify if an address ever exists for this order.
    if (!email) {
      results.push({ orderId: order.id, delivery: "skipped", reason: "no_email" });
      continue;
    }
    try {
      const claimed = await store.claimOrderConfirmation(order.id);
      if (!claimed) {
        // Guard already set (or order gone) — second fire attempt is a no-op.
        results.push({ orderId: order.id, delivery: "skipped", reason: "already_sent" });
        continue;
      }
      const delivery = await sendOrderConfirmation(email, {
        orderId: order.id,
        garment: order.garment,
        feeCents: order.feeCents,
        orderUrl: `${siteOrigin()}/account`,
      });
      // "unconfigured" is its own delivery state (matches the 5b auth seam):
      // no Knock key yet — nothing was attempted, the business op is done.
      const state = delivery.sent
        ? "sent"
        : delivery.reason === "unconfigured"
          ? "unconfigured"
          : "failed";
      results.push({
        orderId: order.id,
        delivery: state,
        ...(delivery.reason ? { reason: delivery.reason } : {}),
      });
      // Trace line: ids/status only — never keys, never full payload bodies.
      console.log(
        `[email] order-confirmation order=${order.id} delivery=${state}${
          delivery.reason ? ` reason=${delivery.reason}` : ""
        }`
      );
    } catch (err) {
      results.push({
        orderId: order.id,
        delivery: "failed",
        reason: err instanceof Error ? err.name : "unknown",
      });
      console.log(
        `[email] order-confirmation order=${order.id} delivery=failed reason=${
          err instanceof Error ? err.name : "unknown"
        }`
      );
    }
  }
  return results;
}

/**
 * Phase 5c hook (b): fire the production-started email after a fulfillment
 * row flips to sent_to_printful. Same guard pattern — the atomic
 * production_notified_at claim makes a second fire a no-op. Never throws.
 */
export async function notifyProductionStarted(item: FulfillmentItem): Promise<
  { orderId: string; delivery: string; reason?: string } | null
> {
  const email = item.customerEmail?.trim();
  // Only when an email exists; guard stays unset so a later attempt can send.
  if (!email) return null;
  try {
    const claimed = await store.claimProductionNotification(item.orderId);
    if (!claimed) return { orderId: item.orderId, delivery: "skipped", reason: "already_sent" };
    const delivery = await sendProductionStarted(email, {
      orderId: item.orderId,
      garment: item.garment,
      printfulStatus: item.printful?.printfulStatus ?? "sent_to_printful",
    });
    // Stamp the short outcome for the owner panel ("sent" or short reason).
    // Best-effort: a failed stamp only costs the panel display, never the send.
    try {
      await store.setProductionNotifyResult(
        item.orderId,
        delivery.sent ? "sent" : (delivery.reason ?? "failed")
      );
    } catch {
      // stamp is cosmetic — ignore its failures
    }
    console.log(
      `[email] order-in-production order=${item.orderId} delivery=${
        delivery.sent ? "sent" : delivery.reason === "unconfigured" ? "unconfigured" : "failed"
      }${delivery.reason ? ` reason=${delivery.reason}` : ""}`
    );
    return {
      orderId: item.orderId,
      delivery: delivery.sent
        ? "sent"
        : delivery.reason === "unconfigured"
          ? "unconfigured"
          : "failed",
      ...(delivery.reason ? { reason: delivery.reason } : {}),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    console.log(`[email] order-in-production order=${item.orderId} delivery=failed reason=${reason}`);
    return { orderId: item.orderId, delivery: "failed", reason };
  }
}
