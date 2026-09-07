// ThreadDrop email delivery (phases 5b + 5c) — Knock (https://knock.app) seam.
//
// Three transactional workflows, all triggered server-side only:
//   - magic-code          login codes (phase 5b)
//   - order-confirmation  paid custom order acknowledged (phase 5c)
//   - order-in-production order entered production at Printful (phase 5c)
// No marketing, no bulk — every recipient is a customer in a live
// transaction. Delivery goes through Knock's REST API. The signing key, if
// ever needed for embedded in-app notification feeds, is resolved here too but
// never leaves the server.
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
/** Workflow keys the owner will create in their Knock dashboard (phase 5c). */
export const KNOCK_MAGIC_CODE_WORKFLOW = "magic-code";
export const KNOCK_ORDER_CONFIRMATION_WORKFLOW = "order-confirmation";
export const KNOCK_PRODUCTION_STARTED_WORKFLOW = "order-in-production";

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
 * Shared Knock trigger. One HTTP call shape for every workflow: Bearer auth,
 * {recipients:[email], data:{...}}, 10s timeout per attempt, structured result —
 * never throws, never echoes the key or the full response body upstream.
 *
 * One retry on transient network-level failures (timeout / connection reset /
 * DNS): login codes are one-shot emails and the live server has shown rare
 * multi-second event-loop stalls where the FIRST attempt dies at exactly the
 * 10s abort even though Knock itself answers in ~0.2s. A single retry keeps
 * worst-case latency bounded (~20s) while rescuing those.
 */
async function triggerWorkflow(
  workflowKey: string,
  email: string,
  data: Record<string, unknown>
): Promise<MailDelivery> {
  let apiKey: string | null = null;
  try {
    apiKey = await resolveKnockApiKey();
  } catch (err) {
    // Config store unavailable — NOT the same as "no key configured".
    // Name the failure so it can never masquerade as unconfigured again.
    const short =
      err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 80) : "unknown";
    console.error(`[mailer] config store failed while resolving Knock key: ${short}`);
    return { sent: false, reason: `store_error:${short}` };
  }
  if (!apiKey) {
    return { sent: false, reason: "unconfigured" };
  }

  const attempt = async (): Promise<MailDelivery> => {
    try {
      const res = await fetch(`${KNOCK_API_BASE}/workflows/${workflowKey}/trigger`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          // Pass recipients as explicit objects: Knock treats a plain string
          // as a user-id (no email attached), so the email step errors out.
          // {id, email} both = the address → email step runs clean (verified
          // live via workflow_recipient_runs: errors 1 → 0).
          recipients: [{ id: email, email }],
          data,
        }),
        // Emails are transactional and time-sensitive — don't hang the caller
        // (a checkout/fulfillment path) on a slow API.
        signal: AbortSignal.timeout(10_000),
      });

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
        // An auth rejection means the RESOLVED key is bad (or revoked) — that
        // is an operator-visible configuration problem, say so in the log.
        if (res.status === 401 || res.status === 403) {
          console.error(
            `[mailer] Knock rejected the configured key for ${workflowKey} (HTTP ${res.status})`
          );
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
      // Network failure / timeout / abort. Keep the transport class in the
      // reason — "unconfigured" is reserved for the no-key case and must
      // NEVER swallow a failed attempt.
      const name = err instanceof Error ? err.name : "unknown";
      const reason =
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : name === "ConnectionError"
            ? "network_error"
            : `network_error:${name.slice(0, 40)}`;
      console.error(`[mailer] trigger ${workflowKey} transport failure: ${reason}`);
      return { sent: false, reason };
    }
  };

  const first = await attempt();
  if (first.sent) return first;
  // Retry exactly once, only on transport-level failures (never on Knock's
  // own 4xx/5xx answers — those are deterministic or need an owner fix).
  if (first.reason === "timeout" || first.reason.startsWith("network_error")) {
    console.error(`[mailer] retrying ${workflowKey} after: ${first.reason}`);
    return attempt();
  }
  return first;
}

/**
 * Email a 6-digit magic login code. Never throws — the caller always gets a
 * structured result and the login flow must not leak whether the email exists.
 */
export async function sendMagicCode(email: string, code: string): Promise<MailDelivery> {
  return triggerWorkflow(KNOCK_MAGIC_CODE_WORKFLOW, email, {
    code,
    // Common template variables; harmless if the workflow ignores them.
    expires_in_minutes: 10,
  });
}

/**
 * Email the order confirmation for a paid custom order (phase 5c). Never
 * throws — the payment/queue flow must complete even if delivery fails.
 */
export async function sendOrderConfirmation(
  email: string,
  payload: { orderId: string; garment: string; feeCents: number; orderUrl: string }
): Promise<MailDelivery> {
  return triggerWorkflow(KNOCK_ORDER_CONFIRMATION_WORKFLOW, email, {
    order_id: payload.orderId,
    garment: payload.garment,
    fee_cents: payload.feeCents,
    fee_usd: (payload.feeCents / 100).toFixed(2),
    order_url: payload.orderUrl,
  });
}

/**
 * Email the customer when their order enters production at Printful (phase
 * 5c). Never throws — the fulfillment flow must complete even if delivery
 * fails.
 */
export async function sendProductionStarted(
  email: string,
  payload: { orderId: string; garment: string; printfulStatus: string }
): Promise<MailDelivery> {
  return triggerWorkflow(KNOCK_PRODUCTION_STARTED_WORKFLOW, email, {
    order_id: payload.orderId,
    garment: payload.garment,
    printful_status: payload.printfulStatus,
  });
}
