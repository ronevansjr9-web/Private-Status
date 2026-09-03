// Dev wiring for the ThreadDrop API: a tiny Vite plugin whose middleware routes
// /api/* requests to the shared handler in src/lib/api.ts, loaded through Vite's
// SSR module runner (so ~/* path aliases resolve exactly as in app code).
// The prod equivalent lives in serve.ts. Both call the same handleApi().

import type { Connect, Plugin } from "vite";

function nodeReqToRequest(
  req: Connect.IncomingMessage,
  body: ReadableStream<Uint8Array> | null
): Request {
  const host = req.headers.host ?? "localhost:3000";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, String(v));
  }
  const method = req.method ?? "GET";
  const init: RequestInit = { method, headers };
  if (body && method !== "GET" && method !== "HEAD") {
    // Node's undici requires duplex:'half' for streaming request bodies.
    init.body = body;
    (init as RequestInit & { duplex: string }).duplex = "half";
  }
  return new Request(url, init);
}

function bodyStream(req: Connect.IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      req.on("end", () => controller.close());
      req.on("error", (err) => controller.error(err));
    },
    cancel() {
      req.destroy();
    },
  });
}

export function threadDropApiPlugin(): Plugin {
  return {
    name: "threaddrop-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (!pathname.startsWith("/api/")) return next();
        try {
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const apiRequest = nodeReqToRequest(
            req,
            hasBody ? bodyStream(req) : null
          );
          const mod = (await server.ssrLoadModule("/src/lib/api.ts")) as {
            handleApi: (r: Request) => Promise<{ status: number; body: unknown } | null>;
          };
          const result = await mod.handleApi(apiRequest);
          if (!result) return next();
          res.statusCode = result.status;
          res.setHeader(
            "content-type",
            result.contentType ?? "application/json"
          );
          const body = result.body as string | Uint8Array | unknown;
          if (typeof body === "string") res.end(body);
          else if (body instanceof Uint8Array) res.end(body);
          else res.end(JSON.stringify(body));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
        }
      });
    },
  };
}
