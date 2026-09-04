// ThreadDrop email delivery (phase 5b) — Knock (https://knock.app) seam.
//
// The customer login flow sends a 6-digit magic code by email. Delivery goes
// through Knock's REST API, triggered server-side only (the signing key, if
// ever needed for embedded in-app notification feeds, is resolved here too but
// never leaves the server).
//
// Credentials resolve in order:
//   1. Environment: KNOCK_API_KEY / KNOCK_SIGNING_KEY (sandbox + published host)
//   2. Config store: td_config keys 'knockApiKey' / 'knockSigningKey'
//      (Postgres mode) or data/config.json (file mode) — settable by the
//      owner tooling without a redeploy.
//
// When neither is set, sendMagicCode returns { sent: false, reason:
// "unconfigured" } and the auth flow still succeeds — the UI shows "email
// delivery coming soon". Nothing here ever returns or logs the code or keys.
//
// Knock REST API (per https://knock.app/docs — "Trigger a workflow" /
// "Send a notification"):
//   POST https://api.knock.app/v1/workflows/{workflow_key}/trigger
//   Authorization: Bearer <secret key>          (sk_... server-side secret)
//   Content-Type: application/json
//   { "recipients": ["<user id or email>"],      // inline email identification
//     "data": { ...workflow payload... } }
//   -> 200 OK { ...workflow run data... }
//   Errors: { "code": <int>, "message": "...", ... } with a 4xx/5xx status.
// The response contract we rely on is deliberately minimal: HTTP 2xx = the
// workflow run was accepted; anything else (or a network error, or an
// unexpected body shape) is reported as { sent: false, reason } so callers can
// degrade gracefully.

import { store, CONFIG_KEYS } from "~/lib/store";

const KNOCK_API_BASE = "https://api.knock.app/v1";
/** Workflow key the owner will create in their Knock dashboard. */
export const KNOCK_MAGIC_CODE_WORKFLOW = "magic-code";

export interface MailDelivery {
  sent: boolean;
  /** "unconfigured" = no API key yet; other reasons describe a failed attempt. */
  reason?: string;
  /** Knock workflow run id when the trigger was accepted. */
  runId?: string;
}

/** Resolve the Knock secret key: env first, then the config store. */
async function resolveKnockApiKey(): Promise<string | null> {
  const env = process.env.KNOCK_API_KEY;
  if (env && env.trim()) return env.trim();
  const stored = await store.getConfig(CONFIG_KEYS.knockApiKey);
  return stored && stored.trim() ? stored.trim() : null;
}

/** Resolve the Knock signing key (only needed for embedded frontends). */
export async function resolveKnockSigningKey(): Promise<string | null> {
  const env = process.env.KNOCK_SIGNING_KEY;
  if (env && env.trim()) return env.trim();
  const stored = await store.getConfig(CONFIG_KEYS.knockSigningKey);
  return stored && stored.trim() ? stored.trim() : null;
}

/**
 * Email a 6-digit magic login code. Never throws — the caller always gets a
 * structured result and the login flow must not leak whether the email exists.
 */
export async function sendMagicCode(email: string, code: string): Promise<MailDelivery> {
  let apiKey: string | null = null;
  try {
    apiKey = await resolveKnockApiKey();
  } catch {
    // Config store unavailable — treat as unconfigured.
    return { sent: false, reason: "unconfigured" };
  }
  if (!apiKey) {
    return { sent: false, reason: "unconfigured" };
  }

  try {
    const res = await fetch(
      `${KNOCK_API_BASE}/workflows/${KNOCK_MAGIC_CODE_WORKFLOW}/trigger`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          // Knock accepts a plain email string as an inline recipient — no
          // pre-registered Knock user object required.
          recipients: [email],
          data: {
            code,
            // Common template variables; harmless if the workflow ignores them.
            expires_in_minutes: 10,
          },
        }),
        // Codes are short-lived — don't hang the request on a slow API.
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      // Known Knock error shape: { code, message, ... }; keep the status and
      // a SHORT reason — never echo the key or full response body upstream.
      let detail = "";
      try {
        const body = (await res.json()) as { message?: unknown };
        if (body && typeof body.message === "string") detail = body.message.slice(0, 120);
      } catch {
        // non-JSON body — leave detail empty
      }
      return {
        sent: false,
        reason: detail
          ? `knock_http_${res.status}: ${detail}`
          : `knock_http_${res.status}`,
      };
    }

    // Defensive: 2xx but unexpected body shape. Accept 200 OK with any JSON
    // object; log nothing sensitive.
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const runId =
        typeof body.id === "string"
          ? body.id
          : typeof body.workflow_run_id === "string"
            ? body.workflow_run_id
            : undefined;
      return { sent: true, ...(runId ? { runId } : {}) };
    } catch {
      return { sent: true };
    }
  } catch (err) {
    // Network failure / timeout / abort.
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network_error";
    return { sent: false, reason };
  }
}
