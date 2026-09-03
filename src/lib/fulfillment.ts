// ThreadDrop fulfillment queue — pushes submitted custom orders into
// fulfillment records via the store layer. The print-on-demand partner will
// consume this queue once its API credentials are connected; until then the
// records wait here and are visible on the owner dashboard.
//
// Server-side only (imports the store module).

import { store, type CustomOrder, type FulfillmentItem } from "~/lib/store";

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
  return {
    queued: created.length,
    queuedAt: created[0]?.queuedAt ?? new Date().toISOString(),
    items,
  };
}
