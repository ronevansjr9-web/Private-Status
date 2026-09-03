import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { getProductBySlug, getProductPayment } from "~/lib/server";
export const Route = createFileRoute("/product/$slug")({
  component: ProductPage,
  loader: async ({ params }) => {
    const product = await getProductBySlug({ data: params.slug });
    if (!product) throw notFound();
    const [tee, hoodie] = await Promise.all([
      getProductPayment({ data: { slug: params.slug, garment: "tee" } }),
      getProductPayment({ data: { slug: params.slug, garment: "hoodie" } }),
    ]);
    return { product, payment: { tee: tee.url, hoodie: hoodie.url } };
  },
});
const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
type Garment = "tee" | "hoodie";
function ProductPage() {
  const { product, payment } = Route.useLoaderData();
  const [garment, setGarment] = useState<Garment>("tee");
  const price = garment === "tee" ? product.priceTeeCents : product.priceHoodieCents;
  const checkoutUrl = payment[garment];
  return (
    <main className="min-h-dvh bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="text-lg font-black tracking-tight">
            ThreadDrop
          </Link>
          <Link
            to="/custom"
            className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-semibold text-white active:bg-neutral-700"
          >
            Custom order
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link to="/" className="text-sm text-neutral-500 hover:underline">
          ← Back to the drop
        </Link>
        <div className="mt-4 grid gap-8 sm:grid-cols-2">
          <img
            src={product.designImageUrl}
            alt={product.name}
            className="aspect-square w-full rounded-2xl border border-neutral-200 bg-white object-cover"
          />
          <div>
            <h1 className="text-3xl font-black tracking-tight">{product.name}</h1>
            <p className="mt-3 text-neutral-600">{product.description}</p>
            <h2 className="mt-6 text-sm font-bold uppercase tracking-widest text-neutral-500">
              Garment
            </h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  ["tee", "Tee", product.priceTeeCents],
                  ["hoodie", "Hoodie", product.priceHoodieCents],
                ] as [Garment, string, number][]
              ).map(([value, label, cents]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setGarment(value)}
                  className={
                    "rounded-xl border px-4 py-3 text-left " +
                    (garment === value
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-300 active:bg-neutral-100")
                  }
                >
                  <span className="block font-semibold">{label}</span>
                  <span
                    className={
                      "mt-0.5 block text-sm " +
                      (garment === value ? "text-neutral-300" : "text-neutral-500")
                    }
                  >
                    {usd(cents)}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-6 text-2xl font-black">{usd(price)}</p>
            {checkoutUrl ? (
              <a
                href={checkoutUrl}
                className="mt-3 block w-full rounded-full bg-neutral-900 px-6 py-3 text-center text-sm font-semibold text-white active:bg-neutral-700"
              >
                Buy now — secure checkout
              </a>
            ) : (
              <div className="mt-3">
                <button
                  type="button"
                  disabled
                  className="w-full cursor-not-allowed rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white opacity-50"
                >
                  Buy now
                </button>
                <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  Checkout launching soon — check back shortly.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
