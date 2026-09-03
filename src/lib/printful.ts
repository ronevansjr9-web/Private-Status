// ThreadDrop Printful client (phase 4a — GET-only thin client).
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
 * Phase 4b order-creation contract (documented now, implemented in 4b —
 * verified against Printful docs; do NOT ship until 4b confirms with a
 * sandbox order):
 *
 * ORDER_SHAPE_COMMENT — POST /orders
 *   POST {BASE}/orders
 *   Headers: Authorization: Bearer <key>, Content-Type: application/json
 *   Body (external_id optional, draft:true to hold without charging):
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

/** Runtime mapping from ThreadDrop garment → Printful catalog variant. */
export interface PrintfulVariantMap {
  tee: { variantId: number; catalogProductId: number } | null;
  hoodie: { variantId: number; catalogProductId: number } | null;
}

// Runtime data file (gitignored, like data/stripe-links.json) — written per
// deployment; the config-store key is the durable source on the live host.
const VARIANTS_FILE = join(process.cwd(), "data", "printful-variants.json");

const KNOWN_VARIANTS: PrintfulVariantMap = {
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
 * Thin GET helper. Never logs or embeds the key anywhere but the auth header.
 * Returns the parsed envelope; throws Error("Printful <status>: <reason>")
 * on non-2xx so callers can surface a clean message.
 */
async function pf(path: string, init?: { method?: string }): Promise<unknown> {
  const key = await resolveKey();
  if (!key) {
    throw new Error("Printful API key is not configured");
  }
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
    },
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
  return pf("/store/products");
}

/** Sync product detail with its variants (needs a bound store). */
export async function getSyncProduct(id: number): Promise<unknown> {
  return pf(`/store/products/${id}`);
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
    const parsed = JSON.parse(raw) as PrintfulVariantMap;
    if (
      parsed &&
      typeof parsed === "object" &&
      ("tee" in parsed || "hoodie" in parsed)
    ) {
      return parsed;
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
