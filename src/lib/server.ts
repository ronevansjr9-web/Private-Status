// ThreadDrop server functions — the only way route components touch the store.
// Server-only (imports src/lib/store.ts, which imports node:fs and src/db.ts).

import { createServerFn } from "@tanstack/react-start";
import { store } from "~/lib/store";

export const getLiveProducts = createServerFn().handler(async () => {
  return store.listProducts();
});

export const getProductBySlug = createServerFn()
  .validator((slug: string) => slug)
  .handler(async ({ data }: { data: string }) => {
    return store.getProductBySlug(data);
  });
