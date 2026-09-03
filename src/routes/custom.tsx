import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CUSTOM_FEE_CENTS } from "~/lib/constants";
import { getCustomPayment } from "~/lib/server";

export const Route = createFileRoute("/custom")({
  component: CustomPage,
});

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

type Garment = "tee" | "hoodie";

function CustomPage() {
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [artworkName, setArtworkName] = useState<string>("");
  const [garment, setGarment] = useState<Garment>("tee");
  const [notes, setNotes] = useState("");
  const [email, setEmail] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ feeCents: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Payment links + amount for the confirmation card. The garment is captured
  // at submit time so later edits to the form can't change the payment.
  const [pay, setPay] = useState<{
    url: string | null;
    printFeeOnlyUrl: string | null;
    amountCents: number;
    feeCents: number;
  } | null>(null);

  async function handleFile(file: File) {
    setUploadError(null);
    setUploading(true);
    setArtworkUrl(null);
    setArtworkName(file.name);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Upload failed (${res.status})`);
      }
      const { url } = (await res.json()) as { url: string };
      setArtworkUrl(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!artworkUrl) {
      setUploadError("Choose an artwork file first");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/custom-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artworkUrl, garment, notes, customerEmail: email }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Could not submit (${res.status})`);
      }
      const order = (await res.json()) as { feeCents: number };
      setConfirmed({ feeCents: order.feeCents });
      try {
        const payData = (await getCustomPayment({
          data: { garment },
        })) as { url: string | null; printFeeOnlyUrl: string | null; amountCents: number };
        setPay({ ...payData, feeCents: order.feeCents });
      } catch {
        setPay(null); // confirmation still renders; payment section hides
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit");
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return (
      <main className="min-h-dvh bg-white text-neutral-900">
        <header className="border-b border-neutral-200">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
            <Link to="/" className="text-lg font-black tracking-tight">
              ThreadDrop
            </Link>
          </div>
        </header>
        <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-2xl">
            ✓
          </div>
          <h1 className="mt-6 text-3xl font-black tracking-tight">Order submitted</h1>
          <p className="mt-3 text-neutral-600">
            Your custom print is in. Complete payment below and we&apos;ll start
            your order right away — the flat custom fee is{" "}
            <strong>{usd(confirmed.feeCents)}</strong>.
          </p>
          {pay?.url ? (
            <div className="mt-8 rounded-2xl border border-neutral-200 bg-neutral-50 p-6 text-left">
              <p className="text-xs font-bold uppercase tracking-widest text-neutral-500">
                Pay now to start your order
              </p>
              <p className="mt-2 text-sm text-neutral-600">
                {usd(pay.amountCents)} — garment plus the flat{" "}
                {usd(pay.feeCents)} custom fee, on Stripe&apos;s secure checkout.
              </p>
              <a
                href={pay.url}
                className="mt-4 block w-full rounded-full bg-neutral-900 px-6 py-3 text-center text-sm font-semibold text-white active:bg-neutral-700"
              >
                Pay {usd(pay.amountCents)} and start your order
              </a>
              {pay.printFeeOnlyUrl && (
                <a
                  href={pay.printFeeOnlyUrl}
                  className="mt-3 block text-center text-xs text-neutral-500 underline hover:text-neutral-700"
                >
                  Pay print fee only ({usd(pay.feeCents)})
                </a>
              )}
              <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                Your order is saved and marked for payment — it enters the
                fulfillment queue as soon as checkout completes.
              </p>
            </div>
          ) : (
            <p className="mt-8 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Checkout launching soon — we&apos;ll email {email || "you"} the
              moment payment opens.
            </p>
          )}
          <Link
            to="/"
            className="mt-8 inline-block rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white"
          >
            Back to the drop
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="text-lg font-black tracking-tight">
            ThreadDrop
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-black tracking-tight">Custom order</h1>
        <p className="mt-2 text-neutral-600">
          Upload your artwork and we&apos;ll print it on the garment of your
          choice for a flat {usd(CUSTOM_FEE_CENTS)} fee.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          <div>
            <label className="block text-sm font-bold uppercase tracking-widest text-neutral-500">
              Artwork
            </label>
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
                "mt-2 cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center " +
                (dragOver ? "border-neutral-900 bg-neutral-50" : "border-neutral-300")
              }
            >
              {artworkUrl ? (
                <img
                  src={artworkUrl}
                  alt="Uploaded artwork"
                  className="mx-auto max-h-40 rounded-lg"
                />
              ) : (
                <p className="text-sm text-neutral-600">
                  {uploading ? "Uploading…" : "Tap to choose an image, or drag it here"}
                </p>
              )}
              {artworkName && (
                <p className="mt-2 text-xs text-neutral-400">{artworkName}</p>
              )}
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
            {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
          </div>

          <div>
            <label htmlFor="garment" className="block text-sm font-bold uppercase tracking-widest text-neutral-500">
              Garment
            </label>
            <select
              id="garment"
              value={garment}
              onChange={(e) => setGarment(e.target.value as Garment)}
              className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-4 py-3"
            >
              <option value="tee">Tee</option>
              <option value="hoodie">Hoodie</option>
            </select>
          </div>

          <div>
            <label htmlFor="notes" className="block text-sm font-bold uppercase tracking-widest text-neutral-500">
              Notes (optional)
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Placement, size, anything else we should know"
              className="mt-2 w-full rounded-xl border border-neutral-300 px-4 py-3"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-bold uppercase tracking-widest text-neutral-500">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-2 w-full rounded-xl border border-neutral-300 px-4 py-3"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !artworkUrl || uploading}
            className="w-full rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {submitting ? "Submitting…" : `Submit custom order — ${usd(CUSTOM_FEE_CENTS)}`}
          </button>
        </form>
      </div>
    </main>
  );
}
