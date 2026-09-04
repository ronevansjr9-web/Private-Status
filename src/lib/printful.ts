// ThreadDrop Printful client (phase 4a GETs + 4b order creation).
//
// Printful REST API v1-style paths on https://api.printful.com, bearer auth.
// Response envelope (verified 2026-09-03 with the account key):
//   { code: <http status>, result: <payload>, error?: {reason, message} }
//
// Endpoint facts verified by live GETs (read-only):
//   GET /stores                  → auth required; result: [] for this account
//   GET /store/products          → auth required; 400 "requires store_id" when
//                                  the key is not bound to a default store
//   GET /products                → PUBLIC (no auth); blank catalog, 535 items;
//                                  entries {id, title, model, type, ...} where
//                                  model is the model number ("3001", "18500")
//   GET /products/{catalog_id}   → PUBLIC; 404 for model numbers — must use
//                                  the catalog id from /products (71 = Bella +
//                                  Canvas 3001, 146 = Gildan 18500). Result:
//                                  {product: {...}, variants: [{id, name,
//                                  size, color, color_code, in_stock}, ...]}
//   GET /catalog/variants/{vid}  → PUBLIC; result: {variant: {id, price,
//                                  currency, size, color: {color_name,
//                                  color_codes}, ...}}
//
// Phase 4b (verified 2026-09-03 against the live store):
//   POST /orders            → creates a DRAFT order when not confirmed; needs
//                             the X-PF-Store-Id header (store-scoped key). Body:
//                             {recipient, items:[{variant_id, quantity,
//                             files:[{url}]}], external_id}
//   POST /orders/{id}/confirm → approves the draft for fulfillment
//   DELETE /orders/{id}     → cancels/deletes a not-yet-fulfilled order
//   The store id itself lives in the printfulVariants config value (see
//   resolveVariantMap) so it is data, not code — never hardcode it here.
//
// Key resolution order: env PRINTFUL_ACCESS_KEY → config store key
// 'printfulApiKey'. Never logged, never sent anywhere but api.printful.com.
//
// Catalog data (blank-garment mapping, public endpoints — no key needed):
//   Bella + Canvas 3001 Unisex Staple T-Shirt → catalog product 71,
//       Black / M variant id 4017 (in stock)
//   Gildan 18500 Unisex Heavy Blend Hoodie → catalog product 146,
//       Black / M variant id 5531 (in stock)
//   NOTE: Printful's "Gildan 18000" (catalog 145) is a CREWNECK SWEATSHIRT,
//   not a hooded garment — 18500 is the hooded equivalent.
//
// Server-side only (uses the config store); never import from client code.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { store, CONFIG_KEYS, isPostgresMode, type ShippingAddress } from "~/lib/store";

const BASE = "https://api.printful.com";

export { type ShippingAddress };

/**
 * Phase 4b order-creation contract (implemented below in createStoreOrder;
 * verified against Printful docs and live in 4b):
 *
 * ORDER_SHAPE_COMMENT — POST /orders
 *   POST {BASE}/orders
 *   Headers: Authorization: Bearer <key>, Content-Type: application/json,
 *            X-PF-Store-Id: <store id from resolveVariantMap>
 *   Body (external_id optional, draft until /confirm):
 *   {
 *     external_id: "threaddrop-custom-<orderId>",
 *     recipient: {            // all required unless noted
 *       name, address1, city, zip, country_code,   // country_code: "US"
 *       state_code?,   // e.g. "CA" (required for US/CA/AU/JP addresses)
 *       phone?, email?
 *     },
 *     items: [{
 *       variant_id: 4017,     // Printful catalog variant (printful-variants.json)
 *       quantity: 1,
 *       files: [{ url: "<public artwork URL>" }],  // CloudFront artwork URL
 *       options?: [{ id: "placement", value: "front" }]
 *     }],
 *     retail_costs?: { shipping: "5.00" }  // what the customer paid
 *   }
 *   → 200 {code, result: {id, status: "draft"|"pending", ...}}
 *   4b flow: queue → POST /orders {draft:true} → confirm POST /orders/{id}/confirm
 *   → listen to webhook (package 'shipment'/'order' events) → update queue row.
 */

/**
 * Runtime mapping from ThreadDrop garment → Printful catalog variant, plus the
 * Printful store the orders target. The store id rides along in this map so it
 * is deployment data (config key 'printfulVariants' / data file), not code.
 * It must be absent (null) when unset — never hardcode a store id here.
 */
export interface PrintfulVariantMap {
  /** Printful store id that orders are placed against (X-PF-Store-Id). */
  storeId: number | null;
  tee: { variantId: number; catalogProductId: number } | null;
  hoodie: { variantId: number; catalogProductId: number } | null;
}

// Runtime data file (gitignored, like data/stripe-links.json) — written per
// deployment; the config-store key is the durable source on the live host.
const VARIANTS_FILE = join(process.cwd(), "data", "printful-variants.json");

const KNOWN_VARIANTS: PrintfulVariantMap = {
  storeId: null,
  tee: { variantId: 4017, catalogProductId: 71 },
  hoodie: { variantId: 5531, catalogProductId: 146 },
};

/** Resolve the Printful key: env PRINTFUL_ACCESS_KEY → config store. Null when unset. */
export async function resolveKey(): Promise<string | null> {
  const envKey = process.env.PRINTFUL_ACCESS_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  try {
    const configKey = await store.getConfig(CONFIG_KEYS.printfulApiKey);
    if (configKey && configKey.trim()) return configKey.trim();
  } catch {
    // config store unavailable (e.g. no DB in a cold file-mode env) — fall through
  }
  return null;
}

/**
 * Thin request helper. Never logs or embeds the key anywhere but the auth
 * header. Returns the parsed envelope; throws Error("Printful <status>:
 * <reason>") on non-2xx so callers can surface a clean message. When the
 * variant map carries a storeId, order endpoints get the X-PF-Store-Id header
 * (required for store-scoped calls like POST /orders).
 */
interface PfInit {
  method?: string;
  /** JSON body (object) — serialized here so callers never build strings. */
  body?: unknown;
  /** Send the X-PF-Store-Id header from the configured variant-map storeId. */
  withStore?: boolean;
}

async function pf(path: string, init?: PfInit): Promise<unknown> {
  const key = await resolveKey();
  if (!key) {
    throw new Error("Printful API key is not configured");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
  };
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (init?.withStore) {
    const map = await resolveVariantMap();
    if (map.storeId == null) {
      throw new Error(
        "Printful store id is not configured (printfulVariants.storeId)"
      );
    }
    headers["X-PF-Store-Id"] = String(map.storeId);
  }
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json().catch(() => null)) as
    | { code?: number; result?: unknown; error?: { reason?: string; message?: string } }
    | null;
  if (!res.ok) {
    const reason = body?.error?.message ?? body?.error?.reason ?? res.statusText;
    throw new Error(`Printful ${res.status}: ${reason}`);
  }
  return body?.result;
}

/** Sync products in the connected Printful store (needs a bound store). */
export async function listSyncProducts(): Promise<unknown> {
  return pf("/store/products", { withStore: true });
}

/** Sync product detail with its variants (needs a bound store). */
export async function getSyncProduct(id: number): Promise<unknown> {
  return pf(`/store/products/${id}`, { withStore: true });
}

// ---------- phase 4b: order creation ----------

/** Result of a successful createStoreOrder call. */
export interface PrintfulOrderResult {
  printfulOrderId: number;
  /** Printful order status right after confirm (e.g. "pending"). */
  status: string;
}

export interface CreateStoreOrderInput {
  /** The fulfillment row / order id — becomes the external_id trace. */
  orderId: string;
  garment: "tee" | "hoodie";
  /** Public artwork URL Printful will print (CloudFront). */
  artworkUrl: string;
  /** Verified recipient address; toPrintfulRecipient formats it. */
  shipping: ShippingAddress;
}

/**
 * Create + confirm a real order in the configured Printful store.
 *
 * Two calls, no mock mode:
 *   1. POST /orders          (X-PF-Store-Id) → draft order, unconfirmed
 *   2. POST /orders/{id}/confirm (X-PF-Store-Id) → approved for fulfillment
 *
 * Throws Error("Printful <status>: <message>") on any Printful failure — the
 * caller (owner endpoint) surfaces that with its status code. If the confirm
 * call fails, the draft order ALREADY exists at Printful; the error message
 * carries the printfulOrderId so the owner can see/cancel it in Printful's
 * dashboard rather than silently double-ordering on a retry.
 */
export async function createStoreOrder(
  input: CreateStoreOrderInput
): Promise<PrintfulOrderResult> {
  const map = await resolveVariantMap();
  if (map.storeId == null) {
    throw new Error(
      "Printful store id is not configured (printfulVariants.storeId)"
    );
  }
  const garmentMap = map[input.garment];
  if (!garmentMap) {
    throw new Error(`No Printful variant mapping for garment "${input.garment}"`);
  }

  const body = {
    // Printful caps external_id length (verified 2026-09-03: 12- and 22-char
    // values accepted, 33+ rejected with 400 "Invalid External ID
    // specified"). Our order ids are c_<ms>_<rand>; truncating to 20 keeps
    // the full millisecond timestamp and stays safely inside the cap.
    external_id: input.orderId.slice(0, 20),
    recipient: toPrintfulRecipient(input.shipping),
    items: [
      {
        variant_id: garmentMap.variantId,
        quantity: 1,
        files: [{ url: input.artworkUrl }],
      },
    ],
  };

  // 1. Draft (unconfirmed) order.
  const draft = (await pf("/orders", {
    method: "POST",
    body,
    withStore: true,
  })) as { id?: number; status?: string } | null;
  const printfulOrderId = draft?.id;
  if (typeof printfulOrderId !== "number") {
    throw new Error("Printful order creation returned no order id");
  }

  // 2. Confirm it for fulfillment.
  try {
    const confirmed = (await pf(`/orders/${printfulOrderId}/confirm`, {
      method: "POST",
      body: {},
      withStore: true,
    })) as { status?: string } | null;
    return {
      printfulOrderId,
      status: typeof confirmed?.status === "string" ? confirmed.status : "pending",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg} (draft order ${printfulOrderId} was created but NOT confirmed — ` +
        `check it in Printful before retrying to avoid a double order)`
    );
  }
}

/** Minimal view of a stored Printful order, from GET /orders/{id}. */
export interface PrintfulOrderView {
  id: number;
  /** Printful's raw status string (e.g. "draft", "pending", "canceled"). */
  status: string;
}

/**
 * Fetch one store order (GET /orders/{id}, X-PF-Store-Id) — the read side of
 * phase 4b, used by the owner status-sync endpoint. Throws Error("Printful
 * <status>: <reason>") on failure (404 for an unknown/deleted order id).
 */
export async function getPrintfulOrder(
  printfulOrderId: number
): Promise<PrintfulOrderView> {
  const result = (await pf(`/orders/${printfulOrderId}`, {
    withStore: true,
  })) as { id?: number; status?: string } | null;
  return {
    id: typeof result?.id === "number" ? result.id : printfulOrderId,
    status: typeof result?.status === "string" ? result.status : "unknown",
  };
}

/**
 * Garment → catalog-variant mapping. Resolution order (same pattern as
 * payments.ts): Postgres mode prefers the config key 'printfulVariants'
 * (set by sync-config/one-off script); file mode reads
 * data/printful-variants.json first. Falls back to the hard-coded verified
 * blank-catalog defaults (Bella+Canvas 3001 / Gildan 18500, Black/M) — never
 * null unless a future explicit null mapping is stored.
 */
export async function resolveVariantMap(): Promise<PrintfulVariantMap> {
  if (isPostgresMode()) {
    const fromConfig = await readConfigVariants();
    if (fromConfig) return fromConfig;
  }
  const fromFile = await readVariantsFile();
  if (fromFile) return fromFile;
  if (!isPostgresMode()) {
    const fromConfig = await readConfigVariants();
    if (fromConfig) return fromConfig;
  }
  return KNOWN_VARIANTS;
}

function parseVariantMap(raw: string | null): PrintfulVariantMap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PrintfulVariantMap>;
    if (
      parsed &&
      typeof parsed === "object" &&
      ("tee" in parsed || "hoodie" in parsed)
    ) {
      // storeId is optional (maps written before the store existed); keep it
      // as a number when present, null otherwise.
      const storeId =
        typeof parsed.storeId === "number" && Number.isFinite(parsed.storeId)
          ? parsed.storeId
          : null;
      return { ...parsed, storeId } as PrintfulVariantMap;
    }
  } catch {
    // fall through
  }
  return null;
}

async function readConfigVariants(): Promise<PrintfulVariantMap | null> {
  try {
    return parseVariantMap(await store.getConfig(CONFIG_KEYS.printfulVariants));
  } catch {
    return null;
  }
}

async function readVariantsFile(): Promise<PrintfulVariantMap | null> {
  try {
    return parseVariantMap(await readFile(VARIANTS_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Map a stored shipping address onto Printful's recipient object shape.
 * Pure formatting — no API call. state_code is included only when present.
 */
export function toPrintfulRecipient(
  shipping: ShippingAddress
): Record<string, string> {
  const recipient: Record<string, string> = {
    name: shipping.name,
    address1: shipping.line1,
    city: shipping.city,
    zip: shipping.zip,
    country_code: shipping.country.toUpperCase(),
  };
  if (shipping.state) recipient.state_code = shipping.state.toUpperCase();
  return recipient;
}
