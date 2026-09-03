// ThreadDrop server functions — the only way route components touch the store.
// Server-only (imports src/lib/store.ts, which imports node:fs and src/db.ts).

import { createServerFn } from "@tanstack/react-start";
import { store, type Garment } from "~/lib/store";
import {
  getCustomPaymentUrl,
  getCustomPrintFeeOnlyUrl,
  getPaymentUrl,
} from "~/lib/payments";
import { CUSTOM_TEE_BASE_CENTS, CUSTOM_HOODIE_BASE_CENTS } from "~/lib/constants";

export const getLiveProducts = createServerFn().handler(async () => {
  return store.listProducts();
});

export const getProductBySlug = createServerFn()
  .validator((slug: string) => slug)
  .handler(async ({ data }: { data: string }) => {
    return store.getProductBySlug(data);
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
