import { createFileRoute, Link } from "@tanstack/react-router";
import { getLiveProducts } from "~/lib/server";
import type { Product } from "~/lib/store";

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => ({ products: await getLiveProducts() }),
});

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

function Home() {
  const { products } = Route.useLoaderData() as { products: Product[] };
  return (
    <main className="min-h-dvh bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <span className="text-lg font-black tracking-tight">ThreadDrop</span>
          <Link
            to="/custom"
            className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-semibold text-white active:bg-neutral-700"
          >
            Custom order
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
        <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-6xl">
          ThreadDrop — drop a design, wear it.
        </h1>
        <p className="mt-4 max-w-xl text-base text-neutral-600 sm:text-lg">
          Submit artwork and it becomes real clothes: printed on demand,
          listed with live checkout, shipped straight to buyers.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <a
            href="#drop"
            className="rounded-full bg-neutral-900 px-6 py-3 text-center text-sm font-semibold text-white active:bg-neutral-700"
          >
            Shop the drop
          </a>
          <Link
            to="/custom"
            className="rounded-full border border-neutral-300 px-6 py-3 text-center text-sm font-semibold active:bg-neutral-100"
          >
            Print my own design
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-14 sm:px-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-neutral-500">
          How it works
        </h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            ["1", "Drop a design", "A prompt or an image — the artwork lands in the drop."],
            ["2", "We build the products", "It goes on tees and hoodies, priced, listed, ready to buy."],
            ["3", "You wear it", "Every order is printed on demand and shipped. No stock, ever."],
          ].map(([n, title, body]) => (
            <li key={n} className="rounded-2xl border border-neutral-200 p-5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-sm font-bold text-white">
                {n}
              </span>
              <h3 className="mt-3 font-bold">{title}</h3>
              <p className="mt-1 text-sm text-neutral-600">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="drop" className="mx-auto max-w-5xl scroll-mt-6 px-4 pb-20 sm:px-6">
        <h2 className="text-2xl font-black tracking-tight">The drop</h2>
        {products.length === 0 ? (
          <p className="mt-4 text-neutral-600">
            Nothing live yet — the first drop is being pressed.
          </p>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <Link
                key={p.id}
                to="/product/$slug"
                params={{ slug: p.slug }}
                className="group block overflow-hidden rounded-2xl border border-neutral-200 active:border-neutral-400"
              >
                <img
                  src={p.designImageUrl}
                  alt={p.name}
                  className="aspect-square w-full bg-white object-cover"
                />
                <div className="flex items-baseline justify-between p-4">
                  <h3 className="font-bold group-hover:underline">{p.name}</h3>
                  <span className="text-sm text-neutral-600">
                    from {usd(Math.min(p.priceTeeCents, p.priceHoodieCents))}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <footer className="border-t border-neutral-200 py-8">
        <p className="mx-auto max-w-5xl px-4 text-sm text-neutral-500 sm:px-6">
          ThreadDrop — printed on demand. Custom orders from $15.
        </p>
      </footer>
    </main>
  );
}
