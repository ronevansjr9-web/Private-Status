// ThreadDrop customer auth (phase 5b) — email magic code + server sessions.
//
// Flow: the customer submits their email on /login, we store a hashed 6-digit
// code with a 10-minute expiry and "email" it (Knock seam in mailer.ts). The
// customer types the code back; on a match we mint a random 128-bit session
// token, store it server-side (td_sessions / data/sessions.json) and set it as
// an httpOnly cookie. /api/my/* reads the cookie, resolves the session and
// scopes every query to that email.
//
// Security notes:
//  - The code is stored only as sha256 hex; the plaintext never persists.
//  - Response to request-code is ALWAYS { ok: true } — no account enumeration.
//  - Rate limit: at most 3 codes per email per 15 minutes (429 otherwise).
//  - Code compare is timing-safe (timingSafeEqual over equal-length digests).
//  - Session cookie: httpOnly + Secure + SameSite=Lax, path=/.
//  - No admin features; owner auth (/owner, X-Owner-Key) is untouched.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { store } from "~/lib/store";
import { sendMagicCode } from "~/lib/mailer";

export const SESSION_COOKIE = "td_session";
/** Login codes live for 10 minutes. */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Sessions live for 30 days. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Rate limit: max codes per email per 15 minutes. */
const CODE_RATE_LIMIT = 3;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RequestCodeResult {
  ok: true;
  /**
   * "sent" = Knock accepted the workflow trigger.
   * "unconfigured" = no Knock key anywhere (env + config store) — nothing was
   * attempted; the UI may show "email delivery coming soon".
   * Anything else (knock_http_*, timeout, network_error*, store_error*) = a
   * REAL attempt failed — reported verbatim so delivery problems can never
   * masquerade as "not configured" again. The response stays ok:true either
   * way (no account enumeration); the code is stored and verifiable.
   */
  delivery: "sent" | "unconfigured" | string;
}

export interface VerifyCodeResult {
  ok: boolean;
  /** Set on success — the caller turns this into the session cookie. */
  token?: string;
  /** Coarse failure bucket for clean UI states (never leaks which failed). */
  error?: "invalid" | "rate_limited" | "error";
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Build the Set-Cookie value for a freshly minted session token. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  // Secure is on even over http in the sandbox — modern browsers treat
  // localhost as a secure context, and the published host is https.
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${maxAgeSeconds}`
  );
}

/** Set-Cookie that clears the session cookie in the browser. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Extract the session token from a request's Cookie header (or null). */
export function sessionTokenFromRequest(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === SESSION_COOKIE && value) return value;
  }
  return null;
}

/** Resolve the logged-in email for a request, or null when anonymous. */
export async function sessionEmailForRequest(req: Request): Promise<string | null> {
  const token = sessionTokenFromRequest(req);
  if (!token) return null;
  const session = await store.findSession(token);
  if (!session) return null;
  return session.email;
}

/**
 * Step 1 — request a login code. Always responds ok:true on the success path
 * (no account enumeration); only malformed input and rate limiting deviate.
 * The rate limit counts UNUSED codes in the window; a consumed code no longer
 * blocks a legitimate re-request.
 */
export async function requestCode(
  rawEmail: string
): Promise<
  | { status: 200; body: RequestCodeResult }
  | { status: 400; body: { ok: false; error: "invalid_email" } }
  | { status: 429; body: { ok: true; error: "rate_limited" } }
> {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { status: 400, body: { ok: false, error: "invalid_email" } };
  }
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const recent = await store.countRecentLoginCodes(email, since);
  if (recent >= CODE_RATE_LIMIT) {
    return { status: 429, body: { ok: true, error: "rate_limited" } };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = new Date();
  await store.createLoginCode({
    email,
    codeHash: sha256Hex(code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    usedAt: null,
    createdAt: now.toISOString(),
  });
  const delivery = await sendMagicCode(email, code);
  // Report the mailer's verdict VERBATIM. Collapsing every failure into
  // "unconfigured" is how a live timeout once hid behind "no key configured"
  // (2026-09-06 live probe: unconfigured at exactly 10.3s = the mailer's 10s
  // abort, next request delivered fine in 0.33s). No sensitive material can
  // appear here: reasons are short transport/status classes, never keys.
  return {
    status: 200,
    body: { ok: true, delivery: delivery.sent ? "sent" : (delivery.reason ?? "failed") },
  };
}

/**
 * Step 2 — verify a code. Single-use: the matching unused row is stamped
 * used_at before the session is created. Timing-safe hash compare.
 */
export async function verifyCode(email: string, code: string): Promise<VerifyCodeResult> {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const normalizedCode = String(code ?? "").trim();
  if (!EMAIL_RE.test(normalizedEmail) || !/^\d{6}$/.test(normalizedCode)) {
    return { ok: false, error: "invalid" };
  }
  const record = await store.findLatestLoginCode(normalizedEmail);
  if (!record) return { ok: false, error: "invalid" };
  const expected = Buffer.from(record.codeHash, "hex");
  const actual = Buffer.from(sha256Hex(normalizedCode), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: "invalid" };
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    return { ok: false, error: "invalid" };
  }
  await store.markLoginCodeUsed(normalizedEmail, record.codeHash);
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await store.createSession({
    token,
    email: normalizedEmail,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  });
  return { ok: true, token };
}

/** Delete the session for a token (logout). Idempotent. */
export async function destroySession(token: string): Promise<void> {
  await store.deleteSession(token);
}
