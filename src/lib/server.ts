// ThreadDrop server functions — the only way route components touch the store.
// Server-only (imports src/lib/store.ts, which imports node:fs and src/db.ts).

import { createServerFn } from "@tanstack/react-start";
import { store, type Garment, type MockupRecord, type Product } from "~/lib/store";
import {
  getCustomPaymentUrl,
  getCustomPrintFeeOnlyUrl,
  getPaymentUrl,
} from "~/lib/payments";
import { getOrGenerateMockups } from "~/lib/mockups";
import { CUSTOM_TEE_BASE_CENTS, CUSTOM_HOODIE_BASE_CENTS } from "~/lib/constants";

export const getLiveProducts = createServerFn().handler(async () => {
  return store.listProducts();
});

/**
 * Product card shape for the landing grid: the product plus the cached flat
 * mockup URL when one exists (tee preferred, hoodie fallback). Read-only —
 * never triggers generation, so the landing page stays fast.
 */
export type LiveProductCard = Product & { flatMockupUrl: string | null };

export const getLiveProductsWithMockups = createServerFn().handler(async () => {
  const products = await store.listProducts();
  return Promise.all(
    products.map(async (p): Promise<LiveProductCard> => {
      let flatMockupUrl: string | null = null;
      try {
        const tee = await store.getMockup(p.designImageUrl, "tee");
        const hoodie = tee ? null : await store.getMockup(p.designImageUrl, "hoodie");
        flatMockupUrl = tee?.flatUrl ?? hoodie?.flatUrl ?? null;
      } catch {
        // cache unavailable — card falls back to the design image
      }
      return { ...p, flatMockupUrl };
    })
  );
});

export const getProductBySlug = createServerFn()
  .validator((slug: string) => slug)
  .handler(async ({ data }: { data: string }) => {
    return store.getProductBySlug(data);
  });

/**
 * Mockup gallery data for a product page. Cache-first per garment; on a cache
 * miss this BOUNDED-ly generates via Printful (the lazy-fill path — a cold
 * design may still return nulls if Printful is rate-limiting; the page then
 * keeps the plain design-image UI until a later visit).
 */
export const getProductMockups = createServerFn()
  .validator((slug: string) => slug)
  .handler(async ({ data }: { data: string }) => {
    const product = await store.getProductBySlug(data);
    const empty = { tee: null, hoodie: null } as {
      tee: MockupRecord | null;
      hoodie: MockupRecord | null;
    };
    if (!product) return empty;
    const [tee, hoodie] = await Promise.all([
      getOrGenerateMockups(product.designImageUrl, "tee"),
      getOrGenerateMockups(product.designImageUrl, "hoodie"),
    ]);
    return { tee, hoodie } satisfies typeof empty;
  });

/**
 * Payment data for a product page: the Stripe hosted checkout URL for the
 * selected garment, or null when no link exists yet (page then shows the
 * "Checkout launching soon" placeholder).
 */
export const getProductPayment = createServerFn()
  .validator((d: { slug: string; garment: Garment }) => d)
  .handler(async ({ data }) => {
    return { url: await getPaymentUrl(data.slug, data.garment) };
  });

/**
 * Payment data for the custom-order flow: the combined payment URL
 * (garment base + flat fee, per store settings), the pay-print-fee-only
 * alternate, the fee, and the full amount to show on the button.
 */
export const getCustomPayment = createServerFn()
  .validator((d: { garment: Garment }) => d)
  .handler(async ({ data }) => {
    const settings = await store.getSettings();
    const feeCents = settings.customFeeCents;
    const baseCents =
      data.garment === "hoodie"
        ? (settings.customHoodieBaseCents ?? CUSTOM_HOODIE_BASE_CENTS)
        : (settings.customTeeBaseCents ?? CUSTOM_TEE_BASE_CENTS);
    const [url, printFeeOnlyUrl] = await Promise.all([
      getCustomPaymentUrl(data.garment),
      getCustomPrintFeeOnlyUrl(data.garment),
    ]);
    return { url, printFeeOnlyUrl, feeCents, amountCents: baseCents + feeCents };
  });
