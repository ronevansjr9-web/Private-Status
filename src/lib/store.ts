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
}

export interface Settings {
  customFeeCents: number;
}

// ---------- adapter selection ----------

const usePostgres = () => !!process.env.DATABASE_URL;

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
};

// ---------- Postgres adapter ----------

const pgAdapter = {
  async init(): Promise<void> {
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
      );
      CREATE TABLE IF NOT EXISTS td_custom_orders (
        id TEXT PRIMARY KEY,
        artwork_url TEXT NOT NULL,
        garment TEXT NOT NULL,
        notes TEXT,
        customer_email TEXT NOT NULL,
        fee_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS td_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `;
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

  async listCustomOrders(): Promise<CustomOrder[]> {
    await this.init();
    const rows = await sql()`
      SELECT id, artwork_url, garment, notes, customer_email,
             fee_cents, status, created_at
      FROM td_custom_orders ORDER BY created_at DESC
    `;
    return rows.map(rowToOrder);
  },

  async createCustomOrder(
    input: Omit<CustomOrder, "id" | "createdAt" | "status">
  ): Promise<CustomOrder> {
    await this.init();
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const rows = await sql()`
      INSERT INTO td_custom_orders (id, artwork_url, garment, notes,
                                    customer_email, fee_cents, status)
      VALUES (${id}, ${input.artworkUrl}, ${input.garment}, ${input.notes ?? null},
              ${input.customerEmail}, ${input.feeCents}, 'submitted')
      RETURNING id, artwork_url, garment, notes, customer_email,
                fee_cents, status, created_at
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
  };
}

// ---------- one interface, chosen per call ----------

export const store = {
  listProducts: () => (usePostgres() ? pgAdapter.listProducts() : fileAdapter.listProducts()),
  getProductBySlug: (s: string) =>
    usePostgres() ? pgAdapter.getProductBySlug(s) : fileAdapter.getProductBySlug(s),
  createProduct: (i: Omit<Product, "id" | "createdAt" | "status">) =>
    usePostgres() ? pgAdapter.createProduct(i) : fileAdapter.createProduct(i),
  listCustomOrders: () =>
    usePostgres() ? pgAdapter.listCustomOrders() : fileAdapter.listCustomOrders(),
  createCustomOrder: (i: Omit<CustomOrder, "id" | "createdAt" | "status">) =>
    usePostgres() ? pgAdapter.createCustomOrder(i) : fileAdapter.createCustomOrder(i),
  getSettings: () => (usePostgres() ? pgAdapter.getSettings() : fileAdapter.getSettings()),
  saveSettings: (s: Settings) =>
    usePostgres() ? pgAdapter.saveSettings(s) : fileAdapter.saveSettings(s),
};
