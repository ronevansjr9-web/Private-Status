import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

/**
 * Customer login (phase 5b) — email magic code.
 * Step 1: type your email -> POST /api/auth/request-code.
 * Step 2: type the 6-digit code -> POST /api/auth/verify (sets the session
 * cookie) -> redirect to /account.
 *
 * Error states are plain and mobile-first. When email delivery is not
 * configured yet (no Knock key), the request still succeeds and the page
 * shows the "email delivery coming soon" hint — the code is never exposed.
 */
function LoginPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deliveryHint, setDeliveryHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDeliveryHint(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/request-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.status === 429) {
        setError("Too many codes requested. Wait a few minutes and try again.");
        return;
      }
      if (res.status === 400) {
        setError("That doesn't look like a valid email address.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      const data = (await res.json()) as { ok: boolean; delivery?: string };
      if (!data.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      if (data.delivery === "unconfigured") {
        setDeliveryHint("Email delivery coming soon — you can still sign in once it's live.");
      }
      setStep("code");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      if (res.ok) {
        await navigate({ to: "/account" });
        return;
      }
      if (res.status === 401) {
        setError("That code didn't match, or it expired. Request a new one.");
        return;
      }
      setError("Something went wrong. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
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

      <div className="mx-auto max-w-md px-4 py-14 sm:px-6">
        {step === "email" ? (
          <>
            <h1 className="text-3xl font-black tracking-tight">Sign in</h1>
            <p className="mt-2 text-neutral-600">
              Enter your email and we&apos;ll send you a 6-digit sign-in code.
            </p>
            <form onSubmit={submitEmail} className="mt-8 flex flex-col gap-4">
              <label className="block">
                <span className="text-sm font-semibold">Email</span>
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-neutral-300 px-4 py-3 text-base outline-none focus:border-neutral-900"
                />
              </label>
              {error && (
                <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </p>
              )}
              {deliveryHint && (
                <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {deliveryHint}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send my code"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-black tracking-tight">Check your email</h1>
            <p className="mt-2 text-neutral-600">
              We sent a 6-digit code to <span className="font-semibold">{email}</span>.
            </p>
            <form onSubmit={submitCode} className="mt-8 flex flex-col gap-4">
              <label className="block">
                <span className="text-sm font-semibold">Code</span>
                <input
                  type="text"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  className="mt-1 w-full rounded-lg border border-neutral-300 px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] outline-none focus:border-neutral-900"
                />
              </label>
              {error && (
                <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className="rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Checking…" : "Verify and sign in"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                  setDeliveryHint(null);
                }}
                className="text-sm text-neutral-500 underline underline-offset-2"
              >
                Use a different email
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
