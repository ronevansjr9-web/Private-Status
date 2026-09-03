// Seed the store with the two demo ThreadDrop products (idempotent).
// Run: bun scripts/seed.ts   (uses the same store module as the app)

import { store } from "../src/lib/store";
import type { Product } from "../src/lib/store";

const DEMO_PRODUCTS: Array<Omit<Product, "id" | "createdAt" | "status">> = [
  {
    slug: "signal-fade",
    name: "Signal Fade",
    description:
      "Bold stacked type dissolving into a glitch bar. For days when the signal drops but you keep transmitting.",
    designImageUrl: "/designs/signal-fade.png",
    priceTeeCents: 2800,
    priceHoodieCents: 4800,
  },
  {
    slug: "static-bloom",
    name: "Static Bloom",
    description:
      "A flower grown from pure TV static with one red pixel at its heart. Noise, but make it bloom.",
    designImageUrl: "/designs/static-bloom.png",
    priceTeeCents: 2800,
    priceHoodieCents: 4800,
  },
];

const existing = await store.listProducts();
let created = 0;
for (const p of DEMO_PRODUCTS) {
  if (existing.some((e) => e.slug === p.slug)) {
    console.log(`= ${p.slug} already live, skipping`);
    continue;
  }
  const made = await store.createProduct(p);
  console.log(`+ seeded ${made.slug} (tee $${made.priceTeeCents / 100} / hoodie $${made.priceHoodieCents / 100})`);
  created++;
}
console.log(`Seed done: ${created} created, ${existing.length} already present.`);
