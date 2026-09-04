// ThreadDrop data layer — the single module all app code imports for persistence.
//
// Two adapters behind one interface:
//  - Postgres (via src/db.ts sql()) when DATABASE_URL is set
//  - JSON files under site/data/ when it is not (zero-config local/dev mode)
//
// Server-side only: route components must access the store through
// createServerFn() handlers or src/routes/api/* handlers, never directly.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "~/db";
import { CUSTOM_FEE_CENTS } from "~/lib/constants";

// ---------- types ----------

export type Garment = "tee" | "hoodie";

export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  designImageUrl: string;
  priceTeeCents: number;
  priceHoodieCents: number;
  status: "live";
  createdAt: string;
  /**
   * Generated design artwork kept in the row itself (Postgres mode only).
   * Letting the SVG live in the DB is what makes designs created in one
   * environment visible everywhere after a deploy — the published host has no
   * access to files written in the sandbox. Undefined for seeded/remote-image
   * products and for file-mode products (those keep their file on disk).
   * Only loaded by getProductByDesignUrl, never shipped to storefront pages.
   */
  designSvg?: string;
}

/** Optional shipping address a customer may attach to a custom order. */
export interface ShippingAddress {
  name: string;
  line1: string;
  city: string;
  /** Optional (state/province/region). */
  state?: string;
  zip: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "US". */
  country: string;
}

export interface CustomOrder {
  id: string;
  artworkUrl: string;
  garment: Garment;
  notes?: string;
  customerEmail: string;
  feeCents: number;
  status: "submitted";
  createdAt: string;
  /** Present only when the customer filled the optional shipping section. */
  shipping?: ShippingAddress;
}

export interface Settings {
  customFeeCents: number;
  /**
   * Optional overrides for the base garment prices used in the custom-order
   * payment amount math (base + fee = combined custom payment link amount).
   * Undefined => fall back to the constants.ts defaults.
   */
  customTeeBaseCents?: number;
  customHoodieBaseCents?: number;
}

// ---------- fulfillment ----------

export type FulfillmentStatus = "queued" | "sent_to_printful";

/** Optional Printful trace stamped on a row when the owner fires the order. */
export interface FulfillmentPrintfulInfo {
  printfulOrderId: number;
  /** Printful order status at confirm time (e.g. "pending"). */
  printfulStatus: string;
  /** ISO timestamp of the successful create+confirm. */
  fulfilledAt: string;
}

export interface FulfillmentItem {
  orderId: string;
  type: "custom";
  garment: Garment;
  artworkUrl: string;
  customerEmail: string;
  feeCents: number;
  status: FulfillmentStatus;
  queuedAt: string;
  /** Present once the one-click "Fulfill via Printful" succeeded. */
  printful?: FulfillmentPrintfulInfo;
}

/**
 * Generated garment mockups for one design (phase 5a). Keyed by the product's
 * design URL + garment; URLs are durable CloudFront copies of Printful's
 * (possibly ephemeral) mockup images. wornUrl is null when only the flat
 * shot came back.
 */
export interface MockupRecord {
  designUrl: string;
  garment: Garment;
  flatUrl: string | null;
  wornUrl: string | null;
  createdAt: string;
}

// ---------- config store (small runtime settings that must survive a deploy) ----------

// Known config keys. Secrets are stored as values, never as key names — key
// names are safe to print; values never are.
export const CONFIG_KEYS = {
  ownerKey: "ownerKey",
  imagePresignUrl: "imagePresignUrl",
  imageToken: "imageToken",
  stripeLinks: "stripeLinks",
  printfulApiKey: "printfulApiKey",
  printfulVariants: "printfulVariants",
} as const;

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS];

// ---------- adapter selection ----------

const usePostgres = () => !!process.env.DATABASE_URL;

/** True when the Postgres adapter is active (DATABASE_URL is set). */
export const isPostgresMode = usePostgres;

// ---------- JSON file adapter (site/data/, gitignored) ----------

// Anchor to the process working directory (the site root in both `vite dev`
// and `bun run serve.ts`) so dev and prod share one data location.
const dataDir = join(process.cwd(), "data");

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(dataDir, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Write to a temp file then rename so a crash never leaves truncated JSON.
async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const finalPath = join(dataDir, name);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tmpPath, finalPath);
}

const fileAdapter = {
  async listProducts(): Promise<Product[]> {
    return readJson<Product[]>("products.json", []);
  },
  async getProductBySlug(slug: string): Promise<Product | null> {
    const products = await readJson<Product[]>("products.json", []);
    return products.find((p) => p.slug === slug) ?? null;
  },
  async createProduct(
    input: Omit<Product, "id" | "createdAt" | "status">
  ): Promise<Product> {
    const products = await readJson<Product[]>("products.json", []);
    const product: Product = {
      ...input,
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "live",
      createdAt: new Date().toISOString(),
    };
    products.push(product);
    await writeJson("products.json", products);
    return product;
  },
  async listCustomOrders(): Promise<CustomOrder[]> {
    return readJson<CustomOrder[]>("custom-orders.json", []);
  },
  async createCustomOrder(
    input: Omit<CustomOrder, "id" | "createdAt" | "status">
  ): Promise<CustomOrder> {
    const orders = await readJson<CustomOrder[]>("custom-orders.json", []);
    const order: CustomOrder = {
      ...input,
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "submitted",
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    await writeJson("custom-orders.json", orders);
    return order;
  },
  async getSettings(): Promise<Settings> {
    return readJson<Settings>("settings.json", {
      customFeeCents: CUSTOM_FEE_CENTS,
    });
  },
  async saveSettings(settings: Settings): Promise<void> {
    await writeJson("settings.json", settings);
  },
  async getConfig(key: ConfigKey): Promise<string | null> {
    const map = await readJson<Record<string, string>>("config.json", {});
    const v = map[key];
    return typeof v === "string" && v ? v : null;
  },
  async setConfig(key: ConfigKey, value: string): Promise<void> {
    const map = await readJson<Record<string, string>>("config.json", {});
    map[key] = value;
    await writeJson("config.json", map);
  },
  async listFulfillmentItems(): Promise<FulfillmentItem[]> {
    return readJson<FulfillmentItem[]>("fulfillment.json", []);
  },
  async createFulfillmentItems(
    items: Array<Omit<FulfillmentItem, "status" | "queuedAt">>
  ): Promise<FulfillmentItem[]> {
    const existing = await readJson<FulfillmentItem[]>("fulfillment.json", []);
    const queued = items.map((item) => ({
      ...item,
      status: "queued" as const,
      queuedAt: new Date().toISOString(),
    }));
    existing.push(...queued);
    await writeJson("fulfillment.json", existing);
    return queued;
  },
  async updateFulfillmentStatus(
    orderId: string,
    update: {
      status: FulfillmentStatus;
      printful?: FulfillmentPrintfulInfo;
    }
  ): Promise<FulfillmentItem | null> {
    const items = await readJson<FulfillmentItem[]>("fulfillment.json", []);
    const idx = items.findIndex((i) => i.orderId === orderId);
    if (idx === -1) return null;
    const updated: FulfillmentItem = {
      ...items[idx],
      status: update.status,
      ...(update.printful ? { printful: update.printful } : {}),
    };
    items[idx] = updated;
    await writeJson("fulfillment.json", items);
    return updated;
  },
  async getFulfillmentItem(orderId: string): Promise<FulfillmentItem | null> {
    const items = await readJson<FulfillmentItem[]>("fulfillment.json", []);
    return items.find((i) => i.orderId === orderId) ?? null;
  },
  // ---------- phase 5a mockup cache (file adapter: data/mockups.json) ----------
  async getMockup(designUrl: string, garment: Garment): Promise<MockupRecord | null> {
    const all = await readJson<MockupRecord[]>("mockups.json", []);
    return (
      all.find((m) => m.designUrl === designUrl && m.garment === garment) ?? null
    );
  },
  async putMockup(record: MockupRecord): Promise<MockupRecord> {
    const all = await readJson<MockupRecord[]>("mockups.json", []);
    const idx = all.findIndex(
      (m) => m.designUrl === record.designUrl && m.garment === record.garment
    );
    if (idx === -1) all.push(record);
    else all[idx] = record;
    await writeJson("mockups.json", all);
    return record;
  },
  async insertMockupIfAbsent(record: MockupRecord): Promise<MockupRecord | null> {
    // Concurrent-dedupe primitive (mirrors the SQL ON CONFLICT DO NOTHING +
    // re-read): returns the WINNING row — the caller's when it won the race,
    // the existing one when another process inserted first — and null never.
    const all = await readJson<MockupRecord[]>("mockups.json", []);
    const existing = all.find(
      (m) => m.designUrl === record.designUrl && m.garment === record.garment
    );
    if (existing) return existing;
    all.push(record);
    await writeJson("mockups.json", all);
    return record;
  },
};

// ---------- Postgres adapter ----------

// init() is DDL-idempotent and awaited by every store operation; over the HTTP
// driver each sql() call is a network round trip, so run it once per process.
// A failed init clears the cache so the next call retries.
let initPromise: Promise<void> | null = null;

async function runInit(): Promise<void> {
  // Neon's serverless driver sends each sql() template as ONE prepared
  // statement over HTTP, so multiple commands in one template fail with
  // "cannot insert multiple commands into a prepared statement" (42601).
  // One statement per call, all idempotent.
  await sql()`
    CREATE TABLE IF NOT EXISTS td_products (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      design_image_url TEXT NOT NULL,
      price_tee_cents INTEGER NOT NULL,
      price_hoodie_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'live',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql()`
    CREATE TABLE IF NOT EXISTS td_custom_orders (
      id TEXT PRIMARY KEY,
      artwork_url TEXT NOT NULL,
      garment TEXT NOT NULL,
      notes TEXT,
      customer_email TEXT NOT NULL,
      fee_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql()`
    CREATE TABLE IF NOT EXISTS td_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `;
  await sql()`
    CREATE TABLE IF NOT EXISTS td_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
  await sql()`
    CREATE TABLE IF NOT EXISTS td_fulfillment (
      order_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      garment TEXT NOT NULL,
      artwork_url TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      fee_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Phase 4b: printful trace columns for rows fired at the print partner.
  // Idempotent ADD COLUMN for tables that predate it.
  await sql()`
    ALTER TABLE td_fulfillment ADD COLUMN IF NOT EXISTS printful_order_id INTEGER
  `;
  await sql()`
    ALTER TABLE td_fulfillment ADD COLUMN IF NOT EXISTS printful_status TEXT
  `;
  await sql()`
    ALTER TABLE td_fulfillment ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ
  `;
  // Designs created after the td_products table may need the SVG column;
  // idempotent ADD COLUMN for tables that predate it.
  await sql()`
    ALTER TABLE td_products ADD COLUMN IF NOT EXISTS design_svg TEXT
  `;
  // Custom orders created before the optional shipping section need the JSONB
  // column; idempotent ALTER for tables that predate it (phase 4a).
  await sql()`
    ALTER TABLE td_custom_orders ADD COLUMN IF NOT EXISTS shipping JSONB
  `;
  // Phase 5a: generated garment mockups per design URL + garment.
  await sql()`
    CREATE TABLE IF NOT EXISTS td_mockups (
      design_url TEXT NOT NULL,
      garment TEXT NOT NULL,
      flat_url TEXT,
      worn_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (design_url, garment)
    )
  `;
}

const pgAdapter = {
  async init(): Promise<void> {
    if (!initPromise) {
      initPromise = runInit().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
  },

  async listProducts(): Promise<Product[]> {
    await this.init();
    const rows = await sql()`
      SELECT id, slug, name, description, design_image_url,
             price_tee_cents, price_hoodie_cents, status, created_at
      FROM td_products WHERE status = 'live' ORDER BY created_at DESC
    `;
    return rows.map(rowToProduct);
  },

  async getProductBySlug(slug: string): Promise<Product | null> {
    await this.init();
    const rows = await sql()`
      SELECT id, slug, name, description, design_image_url,
             price_tee_cents, price_hoodie_cents, status, created_at
      FROM td_products WHERE slug = ${slug} AND status = 'live' LIMIT 1
    `;
    return rows.length ? rowToProduct(rows[0]) : null;
  },

  async createProduct(
    input: Omit<Product, "id" | "createdAt" | "status">
  ): Promise<Product> {
    await this.init();
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const rows = await sql()`
      INSERT INTO td_products (id, slug, name, description, design_image_url,
                               price_tee_cents, price_hoodie_cents, status)
      VALUES (${id}, ${input.slug}, ${input.name}, ${input.description},
              ${input.designImageUrl}, ${input.priceTeeCents},
              ${input.priceHoodieCents}, 'live')
      RETURNING id, slug, name, description, design_image_url,
                price_tee_cents, price_hoodie_cents, status, created_at
    `;
    return rowToProduct(rows[0]);
  },

  /**
   * Postgres variant that also stores the generated SVG in the row, so
   * designs created in any environment render on the published host (which
   * cannot see sandbox files). designImageUrl still points at
   * /api/owner/designs/<slug>.svg — the GET handler transparently serves from
   * this column when the file is absent.
   */
  async createProductWithSvg(
    input: Omit<Product, "id" | "createdAt" | "status">,
    svg: string
  ): Promise<Product> {
    await this.init();
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const rows = await sql()`
      INSERT INTO td_products (id, slug, name, description, design_image_url,
                               price_tee_cents, price_hoodie_cents, status, design_svg)
      VALUES (${id}, ${input.slug}, ${input.name}, ${input.description},
              ${input.designImageUrl}, ${input.priceTeeCents},
              ${input.priceHoodieCents}, 'live', ${svg})
      RETURNING id, slug, name, description, design_image_url,
                price_tee_cents, price_hoodie_cents, status, created_at
    `;
    return rowToProduct(rows[0]);
  },

  /** Load just the design SVG for a product, by its design URL path. */
  async getDesignSvgByUrl(designImageUrl: string): Promise<string | null> {
    await this.init();
    const rows = await sql()`
      SELECT design_svg FROM td_products
      WHERE design_image_url = ${designImageUrl} AND status = 'live' LIMIT 1
    `;
    const v = rows[0]?.design_svg;
    return typeof v === "string" && v ? v : null;
  },

  async getConfig(key: ConfigKey): Promise<string | null> {
    await this.init();
    const rows = await sql()`
      SELECT value FROM td_config WHERE key = ${key} LIMIT 1
    `;
    const v = rows[0]?.value;
    return typeof v === "string" && v ? v : null;
  },

  async setConfig(key: ConfigKey, value: string): Promise<void> {
    await this.init();
    await sql()`
      INSERT INTO td_config (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = ${value}
    `;
  },

  async listCustomOrders(): Promise<CustomOrder[]> {
    await this.init();
    const rows = await sql()`
      SELECT id, artwork_url, garment, notes, customer_email,
             fee_cents, status, created_at, shipping
      FROM td_custom_orders ORDER BY created_at DESC
    `;
    return rows.map(rowToOrder);
  },

  async createCustomOrder(
    input: Omit<CustomOrder, "id" | "createdAt" | "status">
  ): Promise<CustomOrder> {
    await this.init();
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // shipping is optional; the column is JSONB and NULL when absent.
    const shippingJson = input.shipping ? JSON.stringify(input.shipping) : null;
    const rows = await sql()`
      INSERT INTO td_custom_orders (id, artwork_url, garment, notes,
                                    customer_email, fee_cents, status, shipping)
      VALUES (${id}, ${input.artworkUrl}, ${input.garment}, ${input.notes ?? null},
              ${input.customerEmail}, ${input.feeCents}, 'submitted', ${shippingJson}::jsonb)
      RETURNING id, artwork_url, garment, notes, customer_email,
                fee_cents, status, created_at, shipping
    `;
    return rowToOrder(rows[0]);
  },

  async getSettings(): Promise<Settings> {
    await this.init();
    const rows = await sql()`
      SELECT value FROM td_settings WHERE key = 'store' LIMIT 1
    `;
    return rows.length
      ? (rows[0].value as Settings)
      : { customFeeCents: CUSTOM_FEE_CENTS };
  },

  async saveSettings(settings: Settings): Promise<void> {
    await this.init();
    await sql()`
      INSERT INTO td_settings (key, value) VALUES ('store', ${JSON.stringify(settings)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(settings)}::jsonb
    `;
  },

  async listFulfillmentItems(): Promise<FulfillmentItem[]> {
    await this.init();
    const rows = await sql()`
      SELECT order_id, type, garment, artwork_url, customer_email,
             fee_cents, status, queued_at, printful_order_id,
             printful_status, fulfilled_at
      FROM td_fulfillment ORDER BY queued_at DESC
    `;
    return rows.map(rowToFulfillment);
  },

  /**
   * Insert fulfillment records for the given orders. order_id is the primary
   * key, so re-queuing an already-queued order is a no-op for that row
   * (ON CONFLICT DO NOTHING) — the queue endpoint is safe to re-hit.
   */
  async createFulfillmentItems(
    items: Array<Omit<FulfillmentItem, "status" | "queuedAt">>
  ): Promise<FulfillmentItem[]> {
    await this.init();
    const inserted: FulfillmentItem[] = [];
    for (const item of items) {
      const rows = await sql()`
        INSERT INTO td_fulfillment (order_id, type, garment, artwork_url,
                                    customer_email, fee_cents, status)
        VALUES (${item.orderId}, ${item.type}, ${item.garment}, ${item.artworkUrl},
                ${item.customerEmail}, ${item.feeCents}, 'queued')
        ON CONFLICT (order_id) DO NOTHING
        RETURNING order_id, type, garment, artwork_url, customer_email,
                  fee_cents, status, queued_at, printful_order_id,
                  printful_status, fulfilled_at
      `;
      if (rows.length) inserted.push(rowToFulfillment(rows[0]));
    }
    return inserted;
  },

  async getFulfillmentItem(orderId: string): Promise<FulfillmentItem | null> {
    await this.init();
    const rows = await sql()`
      SELECT order_id, type, garment, artwork_url, customer_email,
             fee_cents, status, queued_at, printful_order_id,
             printful_status, fulfilled_at
      FROM td_fulfillment WHERE order_id = ${orderId} LIMIT 1
    `;
    return rows.length ? rowToFulfillment(rows[0]) : null;
  },

  async updateFulfillmentStatus(
    orderId: string,
    update: {
      status: FulfillmentStatus;
      printful?: FulfillmentPrintfulInfo;
    }
  ): Promise<FulfillmentItem | null> {
    await this.init();
    const pf = update.printful;
    const rows = await sql()`
      UPDATE td_fulfillment
      SET status = ${update.status},
          printful_order_id = ${pf ? pf.printfulOrderId : null},
          printful_status = ${pf ? pf.printfulStatus : null},
          fulfilled_at = ${pf ? pf.fulfilledAt : null}::timestamptz
      WHERE order_id = ${orderId}
      RETURNING order_id, type, garment, artwork_url, customer_email,
                fee_cents, status, queued_at, printful_order_id,
                printful_status, fulfilled_at
    `;
    return rows.length ? rowToFulfillment(rows[0]) : null;
  },

  // ---------- phase 5a mockup cache ----------
  async getMockup(designUrl: string, garment: Garment): Promise<MockupRecord | null> {
    await this.init();
    const rows = await sql()`
      SELECT design_url, garment, flat_url, worn_url, created_at
      FROM td_mockups WHERE design_url = ${designUrl} AND garment = ${garment} LIMIT 1
    `;
    return rows.length ? rowToMockup(rows[0]) : null;
  },

  /** Unconditional write (refresh path) — upserts on the UNIQUE pair. */
  async putMockup(record: MockupRecord): Promise<MockupRecord> {
    await this.init();
    const rows = await sql()`
      INSERT INTO td_mockups (design_url, garment, flat_url, worn_url)
      VALUES (${record.designUrl}, ${record.garment}, ${record.flatUrl}, ${record.wornUrl})
      ON CONFLICT (design_url, garment)
      DO UPDATE SET flat_url = ${record.flatUrl}, worn_url = ${record.wornUrl}
      RETURNING design_url, garment, flat_url, worn_url, created_at
    `;
    return rowToMockup(rows[0]);
  },

  /**
   * Concurrent-dedupe primitive (phase 5a): ON CONFLICT DO NOTHING, then
   * re-read the winner. Returns the WINNING row — the caller's when it won
   * the race, the existing one when another process inserted first — so the
   * caller can tell whether its own generation effort was needed.
   */
  async insertMockupIfAbsent(record: MockupRecord): Promise<MockupRecord | null> {
    await this.init();
    const inserted = await sql()`
      INSERT INTO td_mockups (design_url, garment, flat_url, worn_url)
      VALUES (${record.designUrl}, ${record.garment}, ${record.flatUrl}, ${record.wornUrl})
      ON CONFLICT (design_url, garment) DO NOTHING
      RETURNING design_url, garment, flat_url, worn_url, created_at
    `;
    if (inserted.length) return rowToMockup(inserted[0]);
    return this.getMockup(record.designUrl, record.garment);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

function rowToProduct(r: AnyRow): Product {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    description: String(r.description),
    designImageUrl: String(r.design_image_url),
    priceTeeCents: Number(r.price_tee_cents),
    priceHoodieCents: Number(r.price_hoodie_cents),
    status: "live",
    // Dates must cross to the client as strings or React refuses to render them.
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function rowToOrder(r: AnyRow): CustomOrder {
  // shipping is a JSONB object (Postgres) or a pre-parsed object (file mode);
  // tolerate a JSON-encoded string just in case.
  let shipping: ShippingAddress | undefined;
  const rawShipping = r.shipping;
  if (typeof rawShipping === "string" && rawShipping) {
    try {
      shipping = JSON.parse(rawShipping) as ShippingAddress;
    } catch {
      shipping = undefined;
    }
  } else if (rawShipping && typeof rawShipping === "object") {
    shipping = rawShipping as ShippingAddress;
  }
  return {
    id: String(r.id),
    artworkUrl: String(r.artwork_url),
    garment: r.garment === "hoodie" ? "hoodie" : "tee",
    notes: r.notes == null ? undefined : String(r.notes),
    customerEmail: String(r.customer_email),
    feeCents: Number(r.fee_cents),
    status: "submitted",
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    ...(shipping ? { shipping } : {}),
  };
}

function rowToFulfillment(r: AnyRow): FulfillmentItem {
  const printfulOrderId = r.printful_order_id;
  const printfulStatus = r.printful_status;
  const fulfilledAt = r.fulfilled_at;
  const hasPrintful =
    printfulOrderId != null && printfulStatus != null && fulfilledAt != null;
  return {
    orderId: String(r.order_id),
    type: "custom",
    garment: r.garment === "hoodie" ? "hoodie" : "tee",
    artworkUrl: String(r.artwork_url),
    customerEmail: String(r.customer_email),
    feeCents: Number(r.fee_cents),
    status: r.status === "sent_to_printful" ? "sent_to_printful" : "queued",
    queuedAt:
      r.queued_at instanceof Date ? r.queued_at.toISOString() : String(r.queued_at),
    ...(hasPrintful
      ? {
          printful: {
            printfulOrderId: Number(printfulOrderId),
            printfulStatus: String(printfulStatus),
            fulfilledAt:
              fulfilledAt instanceof Date
                ? fulfilledAt.toISOString()
                : String(fulfilledAt),
          },
        }
      : {}),
  };
}

function rowToMockup(r: AnyRow): MockupRecord {
  return {
    designUrl: String(r.design_url),
    garment: r.garment === "hoodie" ? "hoodie" : "tee",
    flatUrl: r.flat_url == null ? null : String(r.flat_url),
    wornUrl: r.worn_url == null ? null : String(r.worn_url),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  };
}

// ---------- one interface, chosen per call ----------

export const store = {
  listProducts: () => (usePostgres() ? pgAdapter.listProducts() : fileAdapter.listProducts()),
  getProductBySlug: (s: string) =>
    usePostgres() ? pgAdapter.getProductBySlug(s) : fileAdapter.getProductBySlug(s),
  createProduct: (i: Omit<Product, "id" | "createdAt" | "status">) =>
    usePostgres() ? pgAdapter.createProduct(i) : fileAdapter.createProduct(i),
  /** Postgres mode only — file mode has no row to store the SVG in. */
  createProductWithSvg: (i: Omit<Product, "id" | "createdAt" | "status">, svg: string) =>
    usePostgres()
      ? pgAdapter.createProductWithSvg(i, svg)
      : fileAdapter.createProduct(i),
  /**
   * Design artwork lookup by design URL path. File mode serves from disk and
   * never needs this; in Postgres mode it reads the td_products.design_svg
   * column. Returns null when the caller should fall back to disk.
   */
  getDesignSvgByUrl: (designImageUrl: string) =>
    usePostgres() ? pgAdapter.getDesignSvgByUrl(designImageUrl) : Promise.resolve(null),
  getConfig: (key: ConfigKey) => (usePostgres() ? pgAdapter.getConfig(key) : fileAdapter.getConfig(key)),
  setConfig: (key: ConfigKey, value: string) =>
    usePostgres() ? pgAdapter.setConfig(key, value) : fileAdapter.setConfig(key, value),
  listCustomOrders: () =>
    usePostgres() ? pgAdapter.listCustomOrders() : fileAdapter.listCustomOrders(),
  createCustomOrder: (i: Omit<CustomOrder, "id" | "createdAt" | "status">) =>
    usePostgres() ? pgAdapter.createCustomOrder(i) : fileAdapter.createCustomOrder(i),
  getSettings: () => (usePostgres() ? pgAdapter.getSettings() : fileAdapter.getSettings()),
  saveSettings: (s: Settings) =>
    usePostgres() ? pgAdapter.saveSettings(s) : fileAdapter.saveSettings(s),
  listFulfillmentItems: () =>
    usePostgres() ? pgAdapter.listFulfillmentItems() : fileAdapter.listFulfillmentItems(),
  createFulfillmentItems: (
    items: Array<Omit<FulfillmentItem, "status" | "queuedAt">>
  ) =>
    usePostgres()
      ? pgAdapter.createFulfillmentItems(items)
      : fileAdapter.createFulfillmentItems(items),
  /** One fulfillment row by order id (null when absent). */
  getFulfillmentItem: (orderId: string) =>
    usePostgres()
      ? pgAdapter.getFulfillmentItem(orderId)
      : fileAdapter.getFulfillmentItem(orderId),
  /** Stamp status + optional Printful trace onto a fulfillment row. */
  updateFulfillmentStatus: (
    orderId: string,
    update: { status: FulfillmentStatus; printful?: FulfillmentPrintfulInfo }
  ) =>
    usePostgres()
      ? pgAdapter.updateFulfillmentStatus(orderId, update)
      : fileAdapter.updateFulfillmentStatus(orderId, update),
  // ---------- phase 5a mockup cache ----------
  /** Cached mockup row for a design URL + garment (null = miss). */
  getMockup: (designUrl: string, garment: Garment) =>
    usePostgres()
      ? pgAdapter.getMockup(designUrl, garment)
      : fileAdapter.getMockup(designUrl, garment),
  /** Unconditional upsert of a mockup row. */
  putMockup: (record: MockupRecord) =>
    usePostgres()
      ? pgAdapter.putMockup(record)
      : fileAdapter.putMockup(record),
  /**
   * Insert-if-absent used by getOrGenerateMockups so two concurrent callers
   * for the same design + garment cannot both pay for a Printful task.
   */
  insertMockupIfAbsent: (record: MockupRecord) =>
    usePostgres()
      ? pgAdapter.insertMockupIfAbsent(record)
      : fileAdapter.insertMockupIfAbsent(record),
};
