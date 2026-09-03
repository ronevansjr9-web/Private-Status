// Seed the config store with runtime credentials that must survive a deploy.
// Idempotent: a row is only written when it is missing — never overwritten.
// Prints ONLY key names + outcome — never values.
//
// Run AFTER a database is connected (DATABASE_URL set), any time before or
// after publish:
//   bun scripts/sync-config.ts
//
// What it seeds (Postgres mode → td_config; file mode → data/config.json):
//   ownerKey       ← /home/team/shared/.secrets/owner-key (if present)
//   imagePresignUrl, imageToken ← IMAGE_UPLOAD_* env vars (if present)
//   stripeLinks    ← data/stripe-links.json contents (the slug → garment →
//                    priceId+url payment-link map; runtime data, not a secret —
//                    stored as a JSON string so payments.ts can read it in
//                    Postgres mode where the data/ file may not exist)
//   printfulVariants ← data/printful-variants.json contents (garment →
//                    Printful catalog variant/product ids; runtime data).
//                    Refresh with REFRESH_PRINTFUL_VARIANTS=1 when the owner
//                    changes the Printful product mapping.
//   (printfulApiKey is seeded separately by scripts/set-printful-key.ts —
//   env values are never read into the config store automatically.)
//
// Values are never printed, logged, or committed.

import { readFile } from "node:fs/promises";
import { store, CONFIG_KEYS, isPostgresMode } from "../src/lib/store";
import type { ConfigKey } from "../src/lib/store";

const OWNER_KEY_PATH = "/home/team/shared/.secrets/owner-key";
const STRIPE_LINKS_PATH = "data/stripe-links.json";
const PRINTFUL_VARIANTS_PATH = "data/printful-variants.json";

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf8");
    const v = raw.trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

interface Seed {
  key: ConfigKey;
  source: string | null;
  label: string;
}

async function main() {
  const mode = isPostgresMode()
    ? "td_config (Postgres mode)"
    : "data/config.json (file mode)";

  const seeds: Seed[] = [
    {
      key: CONFIG_KEYS.ownerKey,
      source: await readTrimmed(OWNER_KEY_PATH),
      label: "owner key file",
    },
    {
      key: CONFIG_KEYS.imagePresignUrl,
      source: process.env.IMAGE_UPLOAD_PRESIGN_URL || null,
      label: "IMAGE_UPLOAD_PRESIGN_URL env",
    },
    {
      key: CONFIG_KEYS.imageToken,
      source: process.env.IMAGE_UPLOAD_TOKEN || null,
      label: "IMAGE_UPLOAD_TOKEN env",
    },
  ];

  for (const { key, source, label } of seeds) {
    const current = await store.getConfig(key);
    if (current) {
      console.log(`= ${key} already set`);
    } else if (source) {
      await store.setConfig(key, source);
      console.log(`+ ${key} set`);
    } else {
      console.log(`- ${key} (no ${label} source available, skipped)`);
    }
  }

  // stripeLinks: read the JSON file and store its raw contents as one config
  // value. Idempotent like the rest; refresh with the REFRESH_STRIPE_LINKS=1
  // env var when the lead replaces payment links.
  try {
    const current = await store.getConfig(CONFIG_KEYS.stripeLinks);
    const raw = await readFile(STRIPE_LINKS_PATH, "utf8");
    const contents = raw.trim();
    if (contents && (current !== contents || process.env.REFRESH_STRIPE_LINKS === "1")) {
      await store.setConfig(CONFIG_KEYS.stripeLinks, contents);
      if (current) {
        console.log(`~ ${CONFIG_KEYS.stripeLinks} updated from ${STRIPE_LINKS_PATH}`);
      } else {
        console.log(`+ ${CONFIG_KEYS.stripeLinks} set from ${STRIPE_LINKS_PATH}`);
      }
    } else if (current) {
      console.log(`= ${CONFIG_KEYS.stripeLinks} already set (matches file)`);
    } else {
      console.log(`- ${CONFIG_KEYS.stripeLinks} (${STRIPE_LINKS_PATH} missing or empty, skipped)`);
    }
  } catch {
    console.log(`- ${CONFIG_KEYS.stripeLinks} (${STRIPE_LINKS_PATH} missing or empty, skipped)`);
  }
  // printfulVariants: garment → Printful catalog variant/product ids (runtime
  // data, not a secret). Same JSON-string pattern as stripeLinks; refresh with
  // REFRESH_PRINTFUL_VARIANTS=1 when the owner changes the mapping.
  try {
    const current = await store.getConfig(CONFIG_KEYS.printfulVariants);
    const raw = (await readFile(PRINTFUL_VARIANTS_PATH, "utf8")).trim();
    if (raw && (current !== raw || process.env.REFRESH_PRINTFUL_VARIANTS === "1")) {
      await store.setConfig(CONFIG_KEYS.printfulVariants, raw);
      if (current) {
        console.log(`~ ${CONFIG_KEYS.printfulVariants} updated from ${PRINTFUL_VARIANTS_PATH}`);
      } else {
        console.log(`+ ${CONFIG_KEYS.printfulVariants} set from ${PRINTFUL_VARIANTS_PATH}`);
      }
    } else if (current) {
      console.log(`= ${CONFIG_KEYS.printfulVariants} already set (matches file)`);
    } else {
      console.log(`- ${CONFIG_KEYS.printfulVariants} (${PRINTFUL_VARIANTS_PATH} missing or empty, skipped)`);
    }
  } catch {
    console.log(`- ${CONFIG_KEYS.printfulVariants} (${PRINTFUL_VARIANTS_PATH} missing or empty, skipped)`);
  }

  console.log(`sync-config done — config store: ${mode}`);
}

main().catch((err) => {
  console.error(
    `sync-config failed: ${err instanceof Error ? err.message : "error"}`
  );
  process.exit(1);
});
