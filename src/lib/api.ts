// ThreadDrop HTTP API — one route table, two wirings:
//  - dev: Vite middleware via configureServer (src/lib/vite-plugin-api.ts)
//  - prod: checked in serve.ts before falling back to the SSR handler
//
// Note: this @tanstack/react-start version has no createAPIFileRoute (verified),
// so endpoints live here instead of src/routes/api/*.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { store, CONFIG_KEYS, isPostgresMode, type ShippingAddress } from "~/lib/store";
import { queueSubmittedCustomOrders } from "~/lib/fulfillment";
import {
  createStoreOrder,
  resolveKey,
  resolveVariantMap,
} from "~/lib/printful";
import {
  defaultDesignName,
  describeDesign,
  describeImageDesign,
  generateDesign,
} from "~/lib/designgen";

export interface ApiResult {
  status: number;
  body: unknown;
  /** Optional content-type override (both wirings default to application/json). */
  contentType?: string;
}

const json = (status: number, body: unknown): ApiResult => ({
  status,
  body: JSON.stringify(body),
});

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Store uploaded artwork via the team image service, server-side so the
 * bearer token never reaches the browser. Contract (verified 2026-09-02):
 *   1. POST $IMAGE_UPLOAD_PRESIGN_URL {Authorization: Bearer $IMAGE_UPLOAD_TOKEN,
 *      content-type: application/json} body {mediaType, contentType, contentLength}
 *      -> {presignedUrl, cloudfrontUrl, alreadyUploaded}
 *   2. PUT raw bytes to presignedUrl with content-type, content-length and
 *      x-amz-server-side-encryption: AES256 (signed header — omitting fails).
 *   3. File is publicly served at cloudfrontUrl (~1.5s to propagate).
 *
 * Credentials resolve in order: env IMAGE_UPLOAD_* (sandbox) → config store
 * (data/config.json in file mode, td_config table in Postgres mode). The
 * config store is what makes uploads work on the published host, where the
 * env vars do not exist; scripts/sync-config.ts seeds it once. Values are
 * never logged.
 */
async function uploadImage(bytes: Uint8Array, contentType: string): Promise<string> {
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

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) throw new Error("File too large (max 10 MB)");
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function slugFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "design";
}

// ---------- owner auth ----------

// The owner key is read from /home/team/shared/.secrets/owner-key at request
// time (never cached, never logged, never sent to the browser — only
// valid/invalid is). Missing file => 503 so the owner knows it's a server
// config problem, not a wrong key.
const OWNER_KEY_PATH = "/home/team/shared/.secrets/owner-key";

async function readOwnerKey(): Promise<string | null> {
  try {
    const raw = await readFile(OWNER_KEY_PATH, "utf8");
    const key = raw.trim();
    return key ? key : null;
  } catch {
    return null;
  }
}

/**
 * Owner key resolution order:
 *   1. env OWNER_KEY (sandbox convenience / override)
 *   2. config store (data/config.json in file mode, td_config in Postgres
 *      mode) — this is what makes owner auth work on the published host,
 *      where the secrets file does not exist
 *   3. the shared secrets file at OWNER_KEY_PATH (sandbox)
 * A missing value in ALL three => 503 (server config problem, not a wrong
 * key). Values are never logged and never sent to the browser.
 */
async function resolveOwnerKey(): Promise<string | null> {
  const envKey = process.env.OWNER_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  const configKey = await store.getConfig(CONFIG_KEYS.ownerKey);
  if (configKey) return configKey;
  return readOwnerKey();
}

/**
 * Returns an ApiResult to send immediately (401 / 503), or null when the
 * request is authenticated. Accepts the key via X-Owner-Key header, ?key=,
 * Authorization: Bearer, or JSON/form body field `key`.
 */
async function ownerAuth(req: Request, bodyKey?: unknown): Promise<ApiResult | null> {
  const expected = await resolveOwnerKey();
  if (!expected) {
    return json(503, { error: "owner key not configured" });
  }
  const provided =
    req.headers.get("x-owner-key") ??
    new URL(req.url).searchParams.get("key") ??
    bearerToken(req) ??
    (typeof bodyKey === "string" && bodyKey ? bodyKey : null);
  if (!provided) return json(401, { error: "Owner key required" });
  if (!keysMatch(provided, expected)) return json(401, { error: "Invalid owner key" });
  return null;
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function keysMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// ---------- owner endpoints (auth via owner key) ----------

const DEFAULT_TEE_CENTS = 2800;
const DEFAULT_HOODIE_CENTS = 4800;

function slugify(name: string): string {
  const base = name.toLowerCase();
  const slug = base
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "design";
}

const designsDir = () => join(process.cwd(), "public", "designs");

// Generated designs are referenced via GET /api/owner/designs/<file> (served
// from disk at request time) rather than the static /designs/ path — files
// written after a build are not in dist/client/, so the static path would 404
// in prod until the next build. The disk location (public/designs/) is the
// same in both wirings.
async function saveDesignSvg(svg: string, filename: string): Promise<string> {
  await mkdir(designsDir(), { recursive: true });
  await writeFile(join(designsDir(), filename), svg, "utf8");
  return `/api/owner/designs/${filename}`;
}

const DESIGN_CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

async function saveDesignBytes(
  bytes: Uint8Array,
  filename: string,
  contentType: string
): Promise<string> {
  await mkdir(designsDir(), { recursive: true });
  await writeFile(join(designsDir(), filename), bytes);
  void contentType;
  return `/api/owner/designs/${filename}`;
}

const extFromContentType = (ct: string): string => {
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("svg")) return "svg";
  return "png";
};

function priceCents(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 100 || n > 100000) return null;
  return n;
}

const designFileTaken = async (filename: string): Promise<boolean> => {
  try {
    await readFile(join(designsDir(), filename));
    return true;
  } catch {
    return false;
  }
};

/**
 * Optional shipping address validation for custom orders. If EVERY field is
 * empty/absent the address counts as "not provided" (ok, null). If any field
 * is set, the required set (name, line1, city, zip, country) must all be
 * present — else field-level errors. state is always optional.
 */
function validateShipping(raw: unknown):
  | { ok: true; value: ShippingAddress | undefined }
  | { ok: false; errors: Record<string, string> } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object") {
    return { ok: false, errors: { shipping: "shipping must be an object" } };
  }
  const s = raw as Record<string, unknown>;
  const get = (k: string): string =>
    typeof s[k] === "string" ? (s[k] as string).trim() : "";
  const anySet = ["name", "line1", "city", "state", "zip", "country"].some(
    (k) => get(k) !== ""
  );
  if (!anySet) return { ok: true, value: undefined };

  const errors: Record<string, string> = {};
  if (!get("name")) errors.name = "Name is required";
  if (!get("line1")) errors.line1 = "Street address is required";
  if (!get("city")) errors.city = "City is required";
  if (!get("zip")) errors.zip = "ZIP / postal code is required";
  if (!get("country")) errors.country = "Country is required";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name: get("name"),
      line1: get("line1"),
      city: get("city"),
      ...(get("state") ? { state: get("state") } : {}),
      zip: get("zip"),
      country: get("country").toUpperCase().slice(0, 2),
    },
  };
}

// ---------- rest of the API ----------

/** Central API handler. Returns null when the path is not an API path. */
export async function handleApi(req: Request): Promise<ApiResult | null> {
  const { pathname, searchParams } = new URL(req.url);
  if (!pathname.startsWith("/api/")) return null;

  try {
    // GET /api/products — live products (?slug= for a single product)
    if (req.method === "GET" && pathname === "/api/products") {
      const slug = searchParams.get("slug");
      if (slug) {
        const product = await store.getProductBySlug(slug);
        return product ? json(200, product) : json(404, { error: "Not found" });
      }
      return json(200, await store.listProducts());
    }

    // POST /api/upload — multipart form with `file`; returns {url}
    if (req.method === "POST" && pathname === "/api/upload") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return json(400, { error: "Missing file field" });
      }
      const contentType = file.type || "application/octet-stream";
      if (!ALLOWED_IMAGE_TYPES[contentType]) {
        return json(415, { error: "Unsupported file type — use PNG, JPG, WebP, GIF or SVG" });
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return json(413, { error: "File too large (max 10 MB)" });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = await uploadImage(bytes, contentType);
      return json(200, { url, filename: file.name, slug: slugFromFilename(file.name) });
    }

    // POST /api/custom-orders — JSON; saves a submitted custom order.
    // Shipping is optional; when any shipping field is set, the required set
    // (name, line1, city, zip, country) must be complete — else 422 with
    // field-level errors.
    if (req.method === "POST" && pathname === "/api/custom-orders") {
      const raw = await req.json();
      const { artworkUrl, garment, notes, customerEmail, shipping } = raw as Record<
        string,
        unknown
      >;
      if (typeof artworkUrl !== "string" || !artworkUrl) {
        return json(400, { error: "artworkUrl is required" });
      }
      if (garment !== "tee" && garment !== "hoodie") {
        return json(400, { error: "garment must be tee or hoodie" });
      }
      if (typeof customerEmail !== "string" || !/^\S+@\S+\.\S+$/.test(customerEmail)) {
        return json(400, { error: "A valid customerEmail is required" });
      }
      const shippingResult = validateShipping(shipping);
      if (!shippingResult.ok) {
        return json(422, {
          error: "Shipping address is incomplete",
          fields: shippingResult.errors,
        });
      }
      const settings = await store.getSettings();
      const order = await store.createCustomOrder({
        artworkUrl,
        garment,
        notes: typeof notes === "string" && notes.trim() ? notes.trim() : undefined,
        customerEmail,
        shipping: shippingResult.value,
        feeCents: settings.customFeeCents,
      });
      return json(201, order);
    }

    // POST /api/fulfillment/queue — push every 'submitted' custom order into
    // the fulfillment queue. Returns {queued, queuedAt} (idempotent: orders
    // already queued are skipped).
    if (req.method === "POST" && pathname === "/api/fulfillment/queue") {
      const result = await queueSubmittedCustomOrders();
      return json(200, { queued: result.queued, queuedAt: result.queuedAt });
    }

    // ---------- owner endpoints ----------
    if (pathname.startsWith("/api/owner/")) {
      // GET /api/owner/designs/<file> — serve generated designs. Order: disk
      // first (file mode and same-host case), then in Postgres mode the
      // td_products.design_svg column — designs created on any host are stored
      // in the DB row, so they render everywhere after a deploy.
      const designMatch = /^\/api\/owner\/designs\/([a-z0-9][a-z0-9._-]{0,80})$/.exec(
        pathname
      );
      if (req.method === "GET" && designMatch) {
        const file = designMatch[1];
        const ext = (file.split(".").pop() ?? "").toLowerCase();
        const contentType = DESIGN_CONTENT_TYPES[ext];
        if (!contentType) return json(404, { error: "Not found" });
        try {
          const data = await readFile(join(designsDir(), file));
          return {
            status: 200,
            body: data,
            contentType,
          };
        } catch {
          // Not on disk: try the DB (Postgres mode only; no-op in file mode).
          const svg = await store.getDesignSvgByUrl(pathname);
          if (svg) {
            return {
              status: 200,
              body: svg,
              contentType,
            };
          }
          return json(404, { error: "Not found" });
        }
      }

      // Everything else under /api/owner/* requires the owner key.
      let bodyKey: unknown;
      let body: Record<string, unknown> | null = null;
      if (req.method === "POST") {
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }
        bodyKey = body?.key;
      }
      const authFailure = await ownerAuth(req, bodyKey);
      if (authFailure) return authFailure;

      // POST /api/owner/designs — owner submits a design; the product is
      // created automatically (slug, copy, prices) and returned live.
      if (req.method === "POST" && pathname === "/api/owner/designs") {
        const b = body as Record<string, unknown>;
        const mode = b.mode;
        const nameInput =
          typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;

        const teeCents = priceCents(b.priceTeeCents) ?? DEFAULT_TEE_CENTS;
        const hoodieCents = priceCents(b.priceHoodieCents) ?? DEFAULT_HOODIE_CENTS;

        let designImageUrl: string | undefined;
        let description: string;
        let name: string;
        // SVG artwork to persist with the product row (Postgres mode). File
        // mode keeps writing to public/designs/ and leaves this unset. The
        // design URL in Postgres mode is derived from the FINAL slug after the
        // collision check below (the GET handler looks the SVG up by URL).
        let designSvg: string | null = null;

        if (mode === "text") {
          const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
          if (!prompt) return json(400, { error: "prompt is required for text mode" });
          if (prompt.length > 500) {
            return json(400, { error: "prompt too long (max 500 chars)" });
          }
          name = nameInput ?? defaultDesignName(prompt);
          const out = await generateDesign(prompt);
          description = describeDesign(prompt, out.engine);
          if (out.svg) {
            if (isPostgresMode()) {
              designSvg = out.svg;
            } else {
              // File mode: write to public/designs/ as before.
              const base = slugify(name);
              let filename = `${base}.svg`;
              let n = 2;
              while (await designFileTaken(filename)) {
                filename = `${base}-${n}.svg`;
                n++;
              }
              designImageUrl = await saveDesignSvg(out.svg, filename);
            }
          } else if (out.imageUrl) {
            // Remote engine returned an image URL or data URI — store locally
            // so the product does not depend on the third-party host.
            try {
              const imgRes = await fetch(out.imageUrl);
              if (!imgRes.ok) throw new Error(`fetch ${imgRes.status}`);
              const ct = imgRes.headers.get("content-type") ?? "image/png";
              if (!ct.startsWith("image/")) throw new Error("not an image");
              const bytes = new Uint8Array(await imgRes.arrayBuffer());
              const base = slugify(name);
              let filename = `${base}.${extFromContentType(ct)}`;
              let n = 2;
              while (await designFileTaken(filename)) {
                filename = `${base}-${n}.${extFromContentType(ct)}`;
                n++;
              }
              designImageUrl = await saveDesignBytes(bytes, filename, ct);
            } catch {
              return json(502, { error: "Design generation succeeded but the image could not be stored" });
            }
          } else {
            return json(500, { error: "Design generation produced no output" });
          }
        } else if (mode === "image") {
          const imageUrl = typeof b.imageUrl === "string" ? b.imageUrl.trim() : "";
          if (!imageUrl) return json(400, { error: "imageUrl is required for image mode" });
          const ok =
            /^https:\/\/[^\s]+$/.test(imageUrl) || /^\/designs\/[a-z0-9._-]+$/.test(imageUrl);
          if (!ok) {
            return json(400, { error: "imageUrl must be an https URL (e.g. the CloudFront URL from /api/upload)" });
          }
          if (!nameInput) {
            return json(400, { error: "name is required for image mode" });
          }
          name = nameInput;
          designImageUrl = imageUrl;
          description = describeImageDesign(name);
        } else {
          return json(400, { error: "mode must be 'text' or 'image'" });
        }

        const existing = await store.listProducts();
        let slug = slugify(name);
        if (existing.some((p) => p.slug === slug)) {
          let n = 2;
          while (existing.some((p) => p.slug === `${slug}-${n}`)) n++;
          slug = `${slug}-${n}`;
        }

        // In Postgres text mode the SVG goes into the row, so the design URL
        // must be derived from the FINAL slug — the GET handler looks the SVG
        // up by this exact URL. File mode already wrote its (possibly -2
        // suffixed) file above, and image mode set its own URL.
        designImageUrl ??= `/api/owner/designs/${slug}.svg`;

        const product =
          designSvg !== null
            ? await store.createProductWithSvg(
                {
                  slug,
                  name,
                  description,
                  designImageUrl,
                  priceTeeCents: teeCents,
                  priceHoodieCents: hoodieCents,
                },
                designSvg
              )
            : await store.createProduct({
                slug,
                name,
                description,
                designImageUrl,
                priceTeeCents: teeCents,
                priceHoodieCents: hoodieCents,
              });
        return json(201, product);
      }

      // GET /api/owner/products — every live product, incl. prices.
      if (req.method === "GET" && pathname === "/api/owner/products") {
        return json(200, await store.listProducts());
      }

      // GET /api/owner/orders — every custom order.
      if (req.method === "GET" && pathname === "/api/owner/orders") {
        return json(200, await store.listCustomOrders());
      }

      // GET /api/owner/fulfillment — the fulfillment queue.
      if (req.method === "GET" && pathname === "/api/owner/fulfillment") {
        return json(200, await store.listFulfillmentItems());
      }

      // GET /api/owner/printful — Printful status probe for the dashboard.
      // Reports resolvability of the key and the variant mapping (incl. the
      // configured store id), plus store connectivity as HTTP status ONLY
      // (never the key, never full response bodies). 502 when the API is
      // unreachable or errors.
      if (req.method === "GET" && pathname === "/api/owner/printful") {
        const key = await resolveKey();
        const keySet = Boolean(key);
        const variants = await resolveVariantMap();
        let storeStatus: number | null = null;
        if (keySet) {
          try {
            const res = await fetch("https://api.printful.com/stores", {
              headers: { Authorization: `Bearer ${key}` },
            });
            storeStatus = res.status;
          } catch {
            storeStatus = null;
          }
        }
        return json(200, {
          keySet,
          storeId: variants.storeId,
          variants,
          storeStatus,
          phase: "4b",
          orderCreation: "live",
        });
      }

      // POST /api/owner/fulfillment/<orderId>/printful — phase 4b one-click
      // fulfillment. Creates a REAL order at Printful (draft + confirm) for
      // the fulfillment row's custom order. Guards, in order:
      //   404 no such fulfillment row · 200 idempotent no-op when already
      //   sent · 422 when the underlying custom order lacks a shipping
      //   address or artwork URL (checked BEFORE any Printful call) ·
      //   Printful errors surface as {error} with Printful's status code.
      if (req.method === "POST" && pathname.startsWith("/api/owner/fulfillment/")) {
        const m = /^\/api\/owner\/fulfillment\/([a-z0-9_]+)\/printful$/.exec(pathname);
        if (!m) return json(404, { error: "Not found" });
        const orderId = m[1];

        const item = await store.getFulfillmentItem(orderId);
        if (!item) {
          return json(404, { error: "No fulfillment item for that order" });
        }

        // Idempotency guard: never create a second Printful order for a row
        // that already went out. Report the recorded state instead.
        if (item.status === "sent_to_printful" && item.printful) {
          return json(200, {
            ok: true,
            idempotent: true,
            item,
          });
        }

        // Preconditions from the underlying custom order — verified BEFORE
        // any Printful call so a bad row can never create a stray order.
        const orders = await store.listCustomOrders();
        const order = orders.find((o) => o.id === orderId);
        if (!order) {
          return json(422, {
            error: "The underlying custom order no longer exists",
          });
        }
        const missing: string[] = [];
        if (!order.shipping) missing.push("shipping address");
        if (!order.artworkUrl) missing.push("artwork URL");
        if (missing.length > 0) {
          return json(422, {
            error:
              `Cannot fulfill via Printful: the order has no ${missing.join(" and ")}. ` +
              "Printful needs a recipient address and printable artwork.",
          });
        }

        try {
          const result = await createStoreOrder({
            orderId,
            garment: item.garment,
            artworkUrl: order.artworkUrl,
            shipping: order.shipping as ShippingAddress,
          });
          const updated = await store.updateFulfillmentStatus(orderId, {
            status: "sent_to_printful",
            printful: {
              printfulOrderId: result.printfulOrderId,
              printfulStatus: result.status,
              fulfilledAt: new Date().toISOString(),
            },
          });
          return json(200, { ok: true, idempotent: false, item: updated });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Printful request failed";
          // Printful errors look like "Printful <status>: <message>" — keep
          // the numeric status so the owner sees the real failure code.
          const pfMatch = /^Printful (\d{3}):/.exec(msg);
          return json(pfMatch ? Number(pfMatch[1]) : 502, {
            error: msg,
          });
        }
      }

      return json(404, { error: "Not found" });
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return json(500, { error: message });
  }
}
