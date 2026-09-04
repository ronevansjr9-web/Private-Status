import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/account")({
  component: AccountPage,
});

/** Order shape returned by GET /api/my/orders (store's CustomerOrderView). */
interface MyOrder {
  id: string;
  garment: "tee" | "hoodie";
  status: string;
  fulfillment: {
    status: "queued" | "sent_to_printful";
    printfulOrderId: number | null;
  } | null;
  feeCents: number;
  createdAt: string;
  artworkUrl: string;
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const dateFmt = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** Status badge mapping — plain, no hype. */
function statusBadge(order: MyOrder): { label: string; className: string } {
  if (order.fulfillment?.status === "sent_to_printful") {
    return {
      label: "In production at Printful",
      className: "bg-blue-100 text-blue-800",
    };
  }
  if (order.fulfillment?.status === "queued") {
    return { label: "In queue", className: "bg-amber-100 text-amber-800" };
  }
  return { label: "Received", className: "bg-neutral-200 text-neutral-700" };
}

/**
 * My Orders (phase 5b) — the logged-in customer's custom orders.
 * Reads the session cookie server-side via GET /api/my/orders; anonymous
 * visitors are redirected to /login. Log out deletes the session.
 */
function AccountPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "anon" }
    | { kind: "ready"; email: string; orders: MyOrder[] }
  >({ kind: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/my/orders");
        if (res.status === 401) {
          if (!cancelled) {
            await navigate({ to: "/login" });
          }
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { email: string; orders: MyOrder[] };
        if (!cancelled) setState({ kind: "ready", email: data.email, orders: data.orders });
      } catch {
        if (!cancelled) setState({ kind: "ready", email: "", orders: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      await navigate({ to: "/" });
    } finally {
      setLoggingOut(false);
    }
  }

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

      <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        {state.kind === "loading" && (
          <p className="text-neutral-500">Loading your orders…</p>
        )}

        {state.kind === "ready" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-3xl font-black tracking-tight">My orders</h1>
                {state.email && (
                  <p className="mt-1 text-sm text-neutral-500">{state.email}</p>
                )}
              </div>
              <button
                type="button"
                onClick={logout}
                disabled={loggingOut}
                className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-50"
              >
                {loggingOut ? "Signing out…" : "Log out"}
              </button>
            </div>

            {state.orders.length === 0 ? (
              <div className="mt-10 rounded-xl border border-dashed border-neutral-300 p-10 text-center">
                <p className="text-neutral-600">No orders yet.</p>
                <p className="mt-1 text-sm text-neutral-500">
                  Custom prints you order will show up here.
                </p>
                <Link
                  to="/custom"
                  className="mt-6 inline-block rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white"
                >
                  Start a custom order
                </Link>
              </div>
            ) : (
              <ul className="mt-8 flex flex-col gap-4">
                {state.orders.map((order) => {
                  const badge = statusBadge(order);
                  return (
                    <li
                      key={order.id}
                      className="flex gap-4 rounded-xl border border-neutral-200 p-4"
                    >
                      <img
                        src={order.artworkUrl}
                        alt={`Custom ${order.garment} artwork`}
                        className="h-20 w-20 shrink-0 rounded-lg border border-neutral-200 bg-neutral-50 object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold capitalize">
                            Custom {order.garment}
                          </span>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-neutral-600">
                          {usd(order.feeCents)} print fee · {dateFmt(order.createdAt)}
                        </p>
                        <p className="mt-1 font-mono text-xs text-neutral-400">
                          {order.id}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </main>
  );
}
