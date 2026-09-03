import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { CUSTOM_FEE_CENTS } from "~/lib/constants";

export const Route = createFileRoute("/owner")({
  // Private owner page: never indexed, never linked from public nav.
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { title: "ThreadDrop — Owner" },
    ],
  }),
  component: OwnerPage,
});

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const KEY_STORAGE = "threaddrop.ownerKey";

interface Product {
  id: string;
  slug: string;
  name: string;
  designImageUrl: string;
  priceTeeCents: number;
  priceHoodieCents: number;
  status: string;
  createdAt: string;
}

interface CustomOrder {
  id: string;
  artworkUrl: string;
  garment: string;
  customerEmail: string;
  feeCents: number;
  status: string;
  createdAt: string;
}

interface FulfillmentItem {
  orderId: string;
  type: string;
  garment: string;
  artworkUrl: string;
  customerEmail: string;
  feeCents: number;
  status: string;
  queuedAt: string;
}

function OwnerPage() {
  const [key, setKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Bootstrap: ?key= param wins (stored, then stripped from the URL so the key
  // doesn't linger in the address bar), then localStorage.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("key");
    if (fromUrl) {
      sessionStorage.setItem(KEY_STORAGE, fromUrl);
      localStorage.setItem(KEY_STORAGE, fromUrl);
      params.delete("key");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : "")
      );
      setKey(fromUrl);
      return;
    }
    const stored = localStorage.getItem(KEY_STORAGE) ?? sessionStorage.getItem(KEY_STORAGE);
    if (stored) setKey(stored);
    else setChecking(false);
  }, []);

  const loadAll = useCallback(
    async (ownerKey: string) => {
      setChecking(true);
      setAuthError(null);
      try {
        const res = await fetch("/api/owner/products", {
          headers: { "X-Owner-Key": ownerKey },
        });
        if (res.status === 401) {
          localStorage.removeItem(KEY_STORAGE);
          sessionStorage.removeItem(KEY_STORAGE);
          setKey(null);
          setAuthError("That key was rejected. Try again.");
        } else if (res.status === 503) {
          setAuthError("Owner key is not configured on the server yet.");
        } else if (!res.ok) {
          setAuthError(`Could not reach the store API (${res.status}).`);
        } else {
          await Promise.all([
            loadProducts(ownerKey),
            loadOrders(ownerKey),
            loadFulfillment(ownerKey),
          ]);
        }
      } catch {
        setAuthError("Could not reach the store API.");
      } finally {
        setChecking(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<CustomOrder[]>([]);
  const [fulfillment, setFulfillment] = useState<FulfillmentItem[]>([]);
  const [queuing, setQueuing] = useState(false);
  const [queueMsg, setQueueMsg] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  const loadProducts = useCallback(async (ownerKey: string) => {
    const res = await fetch("/api/owner/products", {
      headers: { "X-Owner-Key": ownerKey },
    });
    if (res.ok) setProducts((await res.json()) as Product[]);
  }, []);

  const loadOrders = useCallback(async (ownerKey: string) => {
    const res = await fetch("/api/owner/orders", {
      headers: { "X-Owner-Key": ownerKey },
    });
    if (res.ok) setOrders((await res.json()) as CustomOrder[]);
  }, []);

  const loadFulfillment = useCallback(async (ownerKey: string) => {
    const res = await fetch("/api/owner/fulfillment", {
      headers: { "X-Owner-Key": ownerKey },
    });
    if (res.ok) setFulfillment((await res.json()) as FulfillmentItem[]);
  }, []);

  // Push every submitted custom order into the fulfillment queue, then
  // refresh the panel. The endpoint is idempotent (already-queued orders are
  // skipped), so double-clicks are harmless.
  const queueForFulfillment = useCallback(async () => {
    setQueuing(true);
    setQueueMsg(null);
    try {
      const res = await fetch("/api/fulfillment/queue", { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        | { queued?: number; queuedAt?: string; error?: string }
        | null;
      if (!res.ok) {
        setQueueMsg(data?.error ?? `Queueing failed (${res.status}).`);
      } else {
        const n = data?.queued ?? 0;
        setQueueMsg(
          n === 0
            ? "Nothing new to queue — all submitted orders are already queued."
            : `Queued ${n} order${n === 1 ? "" : "s"} for fulfillment.`
        );
        await loadFulfillment(ownerKey);
        await loadOrders(ownerKey);
      }
    } catch {
      setQueueMsg("Could not reach the queue endpoint.");
    } finally {
      setQueuing(false);
    }
  }, [ownerKey, loadFulfillment, loadOrders]);

  useEffect(() => {
    if (key) void loadAll(key);
  }, [key, loadAll]);

  function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault();
    const k = keyInput.trim();
    if (!k) return;
    // Validate before storing: 401 -> show error, don't persist.
    setChecking(true);
    setAuthError(null);
    fetch("/api/owner/products", { headers: { "X-Owner-Key": k } })
      .then(async (res) => {
        if (res.status === 401) {
          setAuthError("Invalid key. Check it and try again.");
        } else if (res.status === 503) {
          setAuthError("Owner key is not configured on the server yet.");
        } else if (!res.ok) {
          setAuthError(`Could not validate the key (${res.status}).`);
        } else {
          localStorage.setItem(KEY_STORAGE, k);
          sessionStorage.setItem(KEY_STORAGE, k);
          setKeyInput("");
          setKey(k);
          return;
        }
      })
      .catch(() => setAuthError("Could not validate the key."))
      .finally(() => setChecking(false));
  }

  if (!key) {
    return (
      <main className="min-h-dvh bg-white text-neutral-900">
        <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
          <h1 className="text-2xl font-black tracking-tight">ThreadDrop owner</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Enter the owner key to manage the store.
          </p>
          <form onSubmit={handleKeySubmit} className="mt-6 space-y-4">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Owner key"
              autoFocus
              className="w-full rounded-xl border border-neutral-300 px-4 py-3"
            />
            {authError && <p className="text-sm text-red-600">{authError}</p>}
            <button
              type="submit"
              disabled={checking || !keyInput.trim()}
              className="w-full rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              {checking ? "Checking…" : "Unlock dashboard"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <Dashboard
      ownerKey={key}
      products={products}
      orders={orders}
      fulfillment={fulfillment}
      queueForFulfillment={queueForFulfillment}
      queuing={queuing}
      queueMsg={queueMsg}
      dataError={dataError}
      setDataError={setDataError}
      onRefresh={async () => {
        setDataError(null);
        try {
          await Promise.all([
            loadProducts(key),
            loadOrders(key),
            loadFulfillment(key),
          ]);
        } catch {
          setDataError("Could not refresh store data.");
        }
      }}
      onLock={() => {
        localStorage.removeItem(KEY_STORAGE);
        sessionStorage.removeItem(KEY_STORAGE);
        setKey(null);
        setProducts([]);
        setOrders([]);
        setFulfillment([]);
        setQueueMsg(null);
      }}
    />
  );
}

function Dashboard(props: {
  ownerKey: string;
  products: Product[];
  orders: CustomOrder[];
  fulfillment: FulfillmentItem[];
  queueForFulfillment: () => Promise<void>;
  queuing: boolean;
  queueMsg: string | null;
  dataError: string | null;
  setDataError: (s: string | null) => void;
  onRefresh: () => Promise<void>;
  onLock: () => void;
}) {
  const {
    ownerKey,
    products,
    orders,
    fulfillment,
    queueForFulfillment,
    queuing,
    queueMsg,
    dataError,
    setDataError,
    onRefresh,
    onLock,
  } = props;

  const [tab, setTab] = useState<"text" | "image">("text");
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [name, setName] = useState("");
  const [tee, setTee] = useState("");
  const [hoodie, setHoodie] = useState("");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Product | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setUploading(true);
    setImageUrl(null);
    setImageName(file.name);
    if (!name.trim()) setName(cleanName(file.name));
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Upload failed (${res.status})`);
      }
      const { url } = (await res.json()) as { url: string };
      setImageUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    if (tab === "text" && !prompt.trim()) {
      setError("Describe the design first.");
      return;
    }
    if (tab === "image" && !imageUrl) {
      setError("Upload artwork first.");
      return;
    }
    const body: Record<string, unknown> =
      tab === "text"
        ? { mode: "text", prompt: prompt.trim() }
        : { mode: "image", imageUrl };
    if (name.trim()) body.name = name.trim();
    const teeC = parsePrice(tee);
    if (teeC !== null) body.priceTeeCents = teeC;
    const hoodC = parsePrice(hoodie);
    if (hoodC !== null) body.priceHoodieCents = hoodC;

    setSubmitting(true);
    try {
      const res = await fetch("/api/owner/designs", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Owner-Key": ownerKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Submit failed (${res.status})`);
      }
      const product = (await res.json()) as Product;
      setCreated(product);
      setPrompt("");
      setImageUrl(null);
      setImageName("");
      setName("");
      setTee("");
      setHoodie("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  const panel =
    "rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6";
  const label =
    "block text-xs font-bold uppercase tracking-widest text-neutral-500";
  const input =
    "mt-2 w-full rounded-xl border border-neutral-300 px-4 py-3 text-base";

  return (
    <main className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="text-lg font-black tracking-tight">
            ThreadDrop <span className="font-medium text-neutral-400">owner</span>
          </div>
          <button
            onClick={onLock}
            className="rounded-full border border-neutral-300 px-4 py-1.5 text-xs font-semibold text-neutral-600"
          >
            Lock
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6 sm:py-10">
        {dataError && <p className="text-sm text-red-600">{dataError}</p>}

        {/* ---- Panel 1: submit a design ---- */}
        <section className={panel} aria-label="Submit a design">
          <h2 className="text-xl font-black tracking-tight">Submit a design</h2>

          {created ? (
            <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4">
              <p className="font-semibold text-green-800">
                Live — &ldquo;{created.name}&rdquo; is on the store.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <Link
                  to="/product/$slug"
                  params={{ slug: created.slug }}
                  className="rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white"
                >
                  View product page
                </Link>
                <button
                  onClick={() => setCreated(null)}
                  className="rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700"
                >
                  Submit another
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-5 space-y-5">
              <div className="grid w-full grid-cols-2 gap-1 rounded-full bg-neutral-100 p-1 text-sm font-semibold">
                <button
                  type="button"
                  onClick={() => setTab("text")}
                  className={
                    "rounded-full py-2 " +
                    (tab === "text" ? "bg-white shadow" : "text-neutral-500")
                  }
                >
                  Text prompt
                </button>
                <button
                  type="button"
                  onClick={() => setTab("image")}
                  className={
                    "rounded-full py-2 " +
                    (tab === "image" ? "bg-white shadow" : "text-neutral-500")
                  }
                >
                  Upload image
                </button>
              </div>

              {tab === "text" ? (
                <div>
                  <label htmlFor="prompt" className={label}>
                    Design prompt
                  </label>
                  <textarea
                    id="prompt"
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder='e.g. "midnight radio — stacked type with a static bar"'
                    className={input}
                  />
                </div>
              ) : (
                <div>
                  <label className={label}>Artwork</label>
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) void handleFile(file);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className={
                      "mt-2 cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center " +
                      (dragOver ? "border-neutral-900 bg-neutral-50" : "border-neutral-300")
                    }
                  >
                    {imageUrl ? (
                      <img src={imageUrl} alt="Uploaded artwork" className="mx-auto max-h-36 rounded-lg" />
                    ) : (
                      <p className="text-sm text-neutral-600">
                        {uploading ? "Uploading…" : "Tap to choose an image, or drag it here"}
                      </p>
                    )}
                    {imageName && <p className="mt-2 text-xs text-neutral-400">{imageName}</p>}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleFile(file);
                    }}
                  />
                </div>
              )}

              <div>
                <label htmlFor="name" className={label}>
                  Product name {tab === "text" ? "(optional)" : ""}
                </label>
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tab === "text" ? "From the prompt if empty" : "Required"}
                  className={input}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="tee" className={label}>
                    Tee price
                  </label>
                  <input
                    id="tee"
                    inputMode="decimal"
                    value={tee}
                    onChange={(e) => setTee(e.target.value)}
                    placeholder="$28 default"
                    className={input}
                  />
                </div>
                <div>
                  <label htmlFor="hoodie" className={label}>
                    Hoodie price
                  </label>
                  <input
                    id="hoodie"
                    inputMode="decimal"
                    value={hoodie}
                    onChange={(e) => setHoodie(e.target.value)}
                    placeholder="$48 default"
                    className={input}
                  />
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={submitting || uploading}
                className="w-full rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white disabled:opacity-40 sm:w-auto"
              >
                {submitting
                  ? "Creating…"
                  : tab === "text"
                    ? "Generate & publish"
                    : "Publish product"}
              </button>
            </form>
          )}
        </section>

        {/* ---- Panel 2: store status ---- */}
        <section className={panel} aria-label="Store status">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-black tracking-tight">Store status</h2>
            <button
              onClick={() => void onRefresh()}
              className="rounded-full border border-neutral-300 px-4 py-1.5 text-xs font-semibold text-neutral-600"
            >
              Refresh
            </button>
          </div>

          <h3 className="mt-5 text-xs font-bold uppercase tracking-widest text-neutral-500">
            Products ({products.length})
          </h3>
          {products.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">Nothing live yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-100">
              {products.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-3">
                  <img
                    src={p.designImageUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-lg border border-neutral-200 bg-white object-contain p-1"
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      to="/product/$slug"
                      params={{ slug: p.slug }}
                      className="block truncate text-sm font-semibold hover:underline"
                    >
                      {p.name}
                    </Link>
                    <p className="text-xs text-neutral-500">
                      {usd(p.priceTeeCents)} tee · {usd(p.priceHoodieCents)} hoodie
                    </p>
                  </div>
                  <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-bold text-green-800">
                    {p.status}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="mt-6 text-xs font-bold uppercase tracking-widest text-neutral-500">
            Custom orders ({orders.length})
          </h3>
          {orders.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">
              No custom orders yet — customers pay a flat {usd(CUSTOM_FEE_CENTS)} fee.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-100">
              {orders.map((o) => (
                <li key={o.id} className="py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{o.customerEmail}</p>
                      <p className="text-xs text-neutral-500">
                        {o.garment} · {usd(o.feeCents)} fee ·{" "}
                        {new Date(o.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </p>
                    </div>
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">
                      {o.status}
                    </span>
                  </div>
                  {o.artworkUrl && (
                    <img
                      src={o.artworkUrl}
                      alt="Custom artwork"
                      className="mt-2 max-h-20 rounded-lg border border-neutral-200"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- Panel 3: fulfillment queue ---- */}
        <section className={panel} aria-label="Fulfillment queue">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-black tracking-tight">
              Fulfillment queue{" "}
              <span className="ml-1 inline-flex min-w-6 items-center justify-center rounded-full bg-neutral-900 px-2 py-0.5 align-middle text-xs font-bold text-white">
                {fulfillment.length}
              </span>
            </h2>
            <button
              onClick={() => void queueForFulfillment()}
              disabled={queuing}
              className="shrink-0 rounded-full bg-neutral-900 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              {queuing ? "Queueing…" : "Queue for fulfillment"}
            </button>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            Custom orders waiting for the print partner. Queueing is idempotent —
            already-queued orders are skipped.
          </p>
          {queueMsg && (
            <p className="mt-2 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2 text-sm text-neutral-700">
              {queueMsg}
            </p>
          )}
          {fulfillment.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">
              Queue is empty. Use the button above to push submitted custom
              orders into fulfillment.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-widest text-neutral-500">
                    <th className="py-2 pr-3 font-bold">Email</th>
                    <th className="py-2 pr-3 font-bold">Garment</th>
                    <th className="py-2 pr-3 font-bold">Fee</th>
                    <th className="py-2 pr-3 font-bold">Queued</th>
                    <th className="py-2 font-bold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {fulfillment.map((f) => {
                    const order = orders.find((o) => o.id === f.orderId);
                    return (
                      <tr key={f.orderId} className="border-b border-neutral-100">
                        <td className="max-w-40 truncate py-2 pr-3 font-medium">
                          {f.customerEmail}
                        </td>
                        <td className="py-2 pr-3 capitalize">{f.garment}</td>
                        <td className="py-2 pr-3">{usd(f.feeCents)}</td>
                        <td className="py-2 pr-3 text-neutral-500">
                          <span title={order ? `Submitted ${new Date(order.createdAt).toLocaleString("en-US")}` : undefined}>
                            {new Date(f.queuedAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                            ,{" "}
                            {new Date(f.queuedAt).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                        </td>
                        <td className="py-2">
                          <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-800">
                            {f.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function parsePrice(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function cleanName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
