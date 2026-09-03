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
//
// Values are never printed, logged, or committed.

import { readFile } from "node:fs/promises";
import { store, CONFIG_KEYS, isPostgresMode } from "../src/lib/store";
import type { ConfigKey } from "../src/lib/store";

const OWNER_KEY_PATH = "/home/team/shared/.secrets/owner-key";

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

  console.log(`sync-config done — config store: ${mode}`);
}

main().catch((err) => {
  console.error(
    `sync-config failed: ${err instanceof Error ? err.message : "error"}`
  );
  process.exit(1);
});
