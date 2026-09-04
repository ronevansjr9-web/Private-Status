// ThreadDrop garment mockups (phase 5a) — Printful Mockup Generator v2.
//
// Flow per design + garment (shapes live-verified 2026-09-05, see
// /home/team/shared/PHASE5A-MOCKUPS-NOTES.md — do NOT re-probe):
//   1. POST /v2/mockup-tasks   (X-PF-Store-Id) — catalog-source task with the
//      design image as a DTG front layer. data is an ARRAY; handle = data[0].id.
//      There is NO task_key in v2 and NO top-level "files" array (v1 shape).
//   2. Poll GET /v2/mockup-tasks?id=<id> every 6s until completed/failed
//      (tasks typically finish in 1–2 min; hard cap ~3.5 min).
//   3. Extract mockup_url per style_id from task.catalog_variant_mockups[].mockups[].
//   4. Re-upload each returned image to OUR storage (team image-upload API):
//      Printful serves mockups from an ephemeral /tmp/ S3 host, so the durable
//      CloudFront URL is what gets cached in td_mockups.
//
// Rate limit (verified): POST/GET 429 when calls are closer than ~20s apart.
// Every 429 sleeps 25s and retries, max 5 attempts.
//
// Server-side only (uses the config store + secrets); never import from client code.

import { store, type Garment, type MockupRecord } from "~/lib/store";
import { CONFIG_KEYS } from "~/lib/store";
import { resolveKey, resolveVariantMap } from "~/lib/printful";

const PRINTFUL_BASE = "https://api.printful.com";

/** Mockup style ids per garment (verified to return images; see notes). */
const MOCKUP_STYLES: Record<Garment, { flat: number; worn: number }> = {
  tee: { flat: 849, worn: 1115 },
  hoodie: { flat: 1402, worn: 1455 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RATE_LIMIT_SLEEP_MS = 25_000; // 429 backoff (docs say ~20s; 25s is safe)
const MAX_429_RETRIES = 5;
const POLL_INTERVAL_MS = 6_000;
const POLL_BUDGET_MS = 210_000; // ~3.5 min ceiling across the whole poll loop

// ---------- image storage (team image-upload contract, verified 2026-09-02) ----------

/**
 * Upload bytes via the team image service; returns the durable CloudFront URL.
 * Contract: POST $IMAGE_UPLOAD_PRESIGN_URL {Bearer $IMAGE_UPLOAD_TOKEN}
 * {mediaType, contentType, contentLength} -> {presignedUrl, cloudfrontUrl};
 * PUT raw bytes to presignedUrl with content-type + content-length +
 * x-amz-server-side-encryption: AES256 (a signed header — omitting fails).
 * Credentials resolve env first, then the config store (published host).
 * This mirrors the uploader in src/lib/api.ts; kept separate so that module
 * stays route-focused and this one has no HTTP-handler imports.
 */
async function uploadImageBytes(bytes: Uint8Array, contentType: string): Promise<string> {
  const presignUrl =
    process.env.IMAGE_UPLOAD_PRESIGN_URL ||
    (await store.getConfig(CONFIG_KEYS.imagePresignUrl));
  const token =
    process.env.IMAGE_UPLOAD_TOKEN || (await store.getConfig(CONFIG_KEYS.imageToken));
  if (!presignUrl || !token) {
    throw new Error("Image upload service is not configured");
  }
  const presignRes = await fetch(presignUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mediaType: contentType,
      contentType,
      contentLength: bytes.byteLength,
    }),
  });
  if (!presignRes.ok) {
    throw new Error(`Presign failed (${presignRes.status})`);
  }
  const { presignedUrl, cloudfrontUrl } = (await presignRes.json()) as {
    presignedUrl: string;
    cloudfrontUrl: string;
  };
  const putRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      "x-amz-server-side-encryption": "AES256",
    },
    body: bytes as unknown as BodyInit,
  });
  if (!putRes.ok) {
    throw new Error(`Image storage failed (${putRes.status})`);
  }
  return cloudfrontUrl;
}

// ---------- Printful v2 mockup task helpers ----------

/** Auth + store headers; throws when the key or store id is not configured. */
async function taskHeaders(): Promise<Record<string, string>> {
  const key = await resolveKey();
  if (!key) throw new Error("Printful API key is not configured");
  const map = await resolveVariantMap();
  if (map.storeId == null) {
    throw new Error("Printful store id is not configured (printfulVariants.storeId)");
  }
  return {
    Authorization: `Bearer ${key}`,
    "X-PF-Store-Id": String(map.storeId),
    "Content-Type": "application/json",
  };
}

interface MockupTaskBody {
  format: "jpg";
  products: Array<{
    source: "catalog";
    catalog_product_id: number;
    catalog_variant_ids: number[];
    mockup_style_ids: number[];
    placements: Array<{
      placement: "front";
      technique: "dtg";
      layers: Array<{ type: "file"; url: string }>;
    }>;
  }>;
}

/**
 * POST /v2/mockup-tasks → the numeric task handle (data[0].id). Returns null
 * on non-retryable failure. 429 → 25s backoff, up to MAX_429_RETRIES.
 */
async function createMockupTask(
  headers: Record<string, string>,
  body: MockupTaskBody
): Promise<number | null> {
  for (let attempt = 1; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(`${PRINTFUL_BASE}/v2/mockup-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      await sleep(RATE_LIMIT_SLEEP_MS);
      continue;
    }
    if (!res.ok) {
      // Body may carry Printful's error message — log only the status + a
      // short reason; the body never contains the key so it is safe to keep.
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Printful mockup task create failed (${res.status}): ${text}`);
    }
    const parsed = (await res.json().catch(() => null)) as {
      data?: Array<{ id?: number }>;
    } | null;
    const id = parsed?.data?.[0]?.id;
    return typeof id === "number" ? id : null;
  }
  return null; // kept hitting 429 — give up for now; lazy-fill will retry later
}

interface PrintfulMockupEntry {
  style_id?: number;
  mockup_url?: string;
}

/**
 * Poll GET /v2/mockup-tasks?id= until completed/failed or the ~3.5 min budget
 * runs out. Returns the mockup entries on success, null otherwise (429s sleep
 * 25s and retry within the same budget).
 */
async function pollMockupTask(
  headers: Record<string, string>,
  taskId: number
): Promise<PrintfulMockupEntry[] | null> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let res: Response;
    try {
      res = await fetch(`${PRINTFUL_BASE}/v2/mockup-tasks?id=${taskId}`, { headers });
    } catch {
      continue; // transient network error — keep polling within budget
    }
    if (res.status === 429) {
      await sleep(RATE_LIMIT_SLEEP_MS);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Printful mockup poll failed (${res.status})`);
    }
    const parsed = (await res.json().catch(() => null)) as {
      data?: Array<{
        status?: string;
        catalog_variant_mockups?: Array<{ mockups?: PrintfulMockupEntry[] }>;
      }>;
    } | null;
    const task = parsed?.data?.[0];
    if (!task) continue;
    if (task.status === "completed") {
      const entries: PrintfulMockupEntry[] = [];
      for (const variant of task.catalog_variant_mockups ?? []) {
        for (const m of variant.mockups ?? []) entries.push(m);
      }
      return entries;
    }
    if (task.status === "failed") {
      return null;
    }
    // pending / processing — keep polling until the deadline.
  }
  return null;
}

// ---------- public API ----------

export interface GeneratedMockups {
  flatUrl: string;
  wornUrl: string | null;
  /** Where the worn shot came from (always "printful" here; kept for the UI seam). */
  wornSource: "printful" | "ai-fallback";
}

/**
 * Generate flat + worn mockups for one design on one garment via Printful v2.
 * Returns null when anything fails (missing key/store, rate-limited out,
 * task failed, no usable images) — callers treat that as "try again later".
 */
export async function generateMockups(
  designUrl: string,
  garment: Garment
): Promise<GeneratedMockups | null> {
  if (!designUrl) return null;

  // Printful fetches the design itself, so it needs an absolute public URL.
  // Relative paths (/designs/x.png) are absolutized against the published
  // host — the artwork is served there (verified) — or, failing that, this
  // host's request origin.
  const publicDesignUrl = await absolutizeDesignUrl(designUrl);
  if (!publicDesignUrl) return null;

  let headers: Record<string, string>;
  try {
    headers = await taskHeaders();
  } catch {
    return null; // Printful not fully configured — mockups are best-effort
  }

  const map = await resolveVariantMap();
  const garmentMap = map[garment];
  const styles = MOCKUP_STYLES[garment];
  if (!garmentMap) return null;

  const body: MockupTaskBody = {
    format: "jpg",
    products: [
      {
        source: "catalog",
        catalog_product_id: garmentMap.catalogProductId,
        catalog_variant_ids: [garmentMap.variantId],
        mockup_style_ids: [styles.flat, styles.worn],
        placements: [
          {
            placement: "front",
            technique: "dtg",
            layers: [{ type: "file", url: publicDesignUrl }],
          },
        ],
      },
    ],
  };

  let taskId: number | null;
  try {
    taskId = await createMockupTask(headers, body);
  } catch {
    return null;
  }
  if (taskId == null) return null;

  let entries: PrintfulMockupEntry[] | null;
  try {
    entries = await pollMockupTask(headers, taskId);
  } catch {
    return null;
  }
  if (!entries) return null;

  const pick = (styleId: number): string | null => {
    const hit = entries?.find((e) => e.style_id === styleId && e.mockup_url);
    return hit?.mockup_url ?? null;
  };
  const flatTmp = pick(styles.flat);
  const wornTmp = pick(styles.worn);
  if (!flatTmp && !wornTmp) return null;

  // Re-host on our storage: Printful's /tmp/ URLs may expire, the CloudFront
  // copies we store must not. Verify each download is a real image before
  // uploading so an HTML error page never becomes a product image.
  let flatUrl: string | null = null;
  let wornUrl: string | null = null;
  try {
    if (flatTmp) flatUrl = await rehost(flatTmp);
    if (wornTmp) wornUrl = await rehost(wornTmp);
  } catch {
    // rehost threw — fall through with whatever succeeded (may be nothing)
  }
  if (!flatUrl && !wornUrl) return null;
  return { flatUrl: flatUrl ?? wornUrl!, wornUrl, wornSource: "printful" };
}

/** Download an image and re-upload it to our storage; returns the new URL. */
async function rehost(tmpUrl: string): Promise<string> {
  const res = await fetch(tmpUrl);
  if (!res.ok) throw new Error(`mockup download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("mockup download was empty");
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  if (!contentType.startsWith("image/")) {
    throw new Error(`mockup download was not an image (${contentType})`);
  }
  return uploadImageBytes(bytes, contentType.split(";")[0]);
}

/**
 * Absolute, public URL for a design image. Absolute http(s) URLs pass through;
 * site-relative paths are resolved against the published host first (the
 * artwork is served there — Printful must be able to fetch it), then against
 * this host's own origin as a fallback for dev.
 */
async function absolutizeDesignUrl(designUrl: string): Promise<string | null> {
  if (/^https?:\/\//i.test(designUrl)) return designUrl;
  if (!designUrl.startsWith("/")) return null;
  const host = process.env.TD_PUBLIC_SITE_URL || "https://threaddrop.ctonew.app";
  const candidate = `${host.replace(/\/+$/, "")}${designUrl}`;
  try {
    const probe = await fetch(candidate, { method: "HEAD" });
    if (probe.ok) return candidate;
  } catch {
    // fall through to own-origin fallback
  }
  // Own origin (dev / published-host request): use the incoming request URL.
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const url = new URL(getRequest().url);
    return `${url.origin}${designUrl}`;
  } catch {
    return candidate;
  }
}

/**
 * Cache-first entry point: return the cached mockup row when present, else
 * generate via Printful and store. The store's insertMockupIfAbsent (SQL
 * INSERT … ON CONFLICT DO NOTHING + re-read) keeps two concurrent callers from
 * both paying for a Printful task. Never throws — failures return the best
 * known state (null when nothing is cached either).
 */
export async function getOrGenerateMockups(
  designUrl: string,
  garment: Garment
): Promise<MockupRecord | null> {
  if (!designUrl) return null;
  try {
    const cached = await store.getMockup(designUrl, garment);
    if (cached) return cached;
  } catch {
    // cache lookup failure must not block generation
  }

  let generated: GeneratedMockups | null = null;
  try {
    generated = await generateMockups(designUrl, garment);
  } catch {
    return null;
  }
  if (!generated) return null;

  const record: MockupRecord = {
    designUrl,
    garment,
    flatUrl: generated.flatUrl,
    wornUrl: generated.wornUrl,
    createdAt: new Date().toISOString(),
  };
  try {
    // Winner semantics: the caller's record when it won the race, the
    // already-stored row when another process inserted first.
    return await store.insertMockupIfAbsent(record);
  } catch {
    // Storage failed — still report the generated URLs for this request.
    return record;
  }
}
