// ThreadDrop payments — Stripe hosted payment links.
//
// The platform's managed Stripe provides hosted payment LINKS (not API keys).
// The lead created one link per product × garment plus three custom-order
// links; the mapping lives in data/stripe-links.json (runtime data, gitignored
// — real payment URLs, never secrets, never committed).
//
// Resolution order (per the phase-3 brief):
//   1. data/stripe-links.json (file mode / sandbox)
//   2. config store key 'stripeLinks' (Postgres mode: td_config; seeded by
//      scripts/sync-config.ts when a database is connected)
//   3. none → every lookup returns null → pages keep the
//      "Checkout launching soon" placeholder
//
// Server-side only: routes get payment URLs via createServerFn() in
// src/lib/server.ts, never by importing this module directly.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { store, CONFIG_KEYS, isPostgresMode, type Garment } from "~/lib/store";

interface LinkEntry {
  priceId: string;
  url: string;
}

type StripeLinks = Record<string, Record<string, LinkEntry>>;

const LINKS_FILE = join(process.cwd(), "data", "stripe-links.json");

/** Cache file reads for 5s so a burst of requests doesn't hammer the disk. */
let fileCache: { at: number; links: StripeLinks | null } | null = null;
const FILE_CACHE_MS = 5_000;

async function readLinksFile(): Promise<StripeLinks | null> {
  const now = Date.now();
  if (fileCache && now - fileCache.at < FILE_CACHE_MS) return fileCache.links;
  try {
    const raw = await readFile(LINKS_FILE, "utf8");
    const parsed = JSON.parse(raw) as StripeLinks;
    fileCache = { at: now, links: parsed && typeof parsed === "object" ? parsed : null };
  } catch {
    fileCache = { at: now, links: null };
  }
  return fileCache.links;
}

/**
 * Postgres mode prefers the config-store key 'stripeLinks' (set by
 * sync-config.ts) over the local file — the deployed host may have no
 * data/ directory. File mode has no config key seeded for this in practice,
 * but the lookup is mode-agnostic and harmless.
 */
async function readConfigLinks(): Promise<StripeLinks | null> {
  try {
    const raw = await store.getConfig(CONFIG_KEYS.stripeLinks);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StripeLinks;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveLinks(): Promise<StripeLinks | null> {
  // Postgres mode prefers the config key over the local file (the deployed
  // host may have no data/ directory). File mode tries the file first, then
  // the config key as fallback — spec order: file → config → none → null.
  if (isPostgresMode()) {
    const fromConfig = await readConfigLinks();
    if (fromConfig) return fromConfig;
  }
  const fromFile = await readLinksFile();
  if (fromFile) return fromFile;
  return readConfigLinks();
}

function lookup(links: StripeLinks | null, key: string, garment: string): string | null {
  const entry = links?.[key]?.[garment];
  return entry && typeof entry.url === "string" && entry.url ? entry.url : null;
}

/** Stripe hosted checkout URL for a product × garment, or null. */
export async function getPaymentUrl(
  slug: string,
  garment: Garment
): Promise<string | null> {
  return lookup(await resolveLinks(), slug, garment);
}

/** Combined (garment price + flat fee) custom-order payment URL, or null. */
export async function getCustomPaymentUrl(garment: Garment): Promise<string | null> {
  return lookup(await resolveLinks(), "custom", garment);
}

/** Pay-print-fee-only custom-order payment URL, or null. */
export async function getCustomPrintFeeOnlyUrl(garment: Garment): Promise<string | null> {
  return lookup(await resolveLinks(), "custom", "printFeeOnly");
}
