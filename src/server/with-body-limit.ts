import "server-only";

/**
 * Per-endpoint body size limiter for Next.js API route handlers.
 *
 * Wraps a route handler so the request body is consumed through a
 * counting `TransformStream`. If the stream exceeds `maxBytes` the
 * request is aborted and a 413 Payload Too Large response is returned
 * — regardless of what the `Content-Length` header claims.
 *
 * Usage:
 *
 * ```ts
 * export const POST = withBodyLimit(35_000_000, async (request) => {
 *   const form = await request.formData(); // safe — body was capped
 *   // ...
 * });
 * ```
 *
 * Design notes:
 *  - We replace `request.body` with a byte-capped clone. The original
 *    stream is consumed and piped through; if the cap is hit, the pipe
 *    errors out and `request.formData()` / `.text()` / `.json()` will
 *    throw, which we catch and convert to 413.
 *  - GET/HEAD/OPTIONS requests are passed through unchanged.
 *  - The utility is intentionally generic — it works with any method
 *    and any content type.
 */

type RouteContext = { params: Promise<Record<string, string>> };

type RouteHandler = (request: Request, context?: RouteContext) => Response | Promise<Response>;

export class PayloadTooLargeError extends Error {
  code = "PayloadTooLarge" as const;
  constructor(maxBytes: number) {
    super(`Request body exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MB limit.`);
  }
}

/**
 * Wrap a route handler with a hard body-size cap. The cap is enforced
 * at the stream level — a spoofed `Content-Length` header cannot
 * bypass it.
 */
export function withBodyLimit(maxBytes: number, handler: RouteHandler): RouteHandler {
  return async (request: Request, context?: RouteContext) => {
    // Nothing to limit for body-less methods.
    if (!request.body) {
      return handler(request, context);
    }

    // Fast-path: if Content-Length is honestly declared AND exceeds
    // the cap, reject immediately without consuming any bytes.
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maxBytes) {
      return new Response(
        JSON.stringify({
          error: `Payload příliš velký (${(declaredLength / 1024 / 1024).toFixed(1)} MB). Limit je ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`,
        }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Stream-level enforcement: pipe the original body through a
    // counting transform that aborts when the cap is hit.
    let consumed = 0;
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        consumed += chunk.byteLength;
        if (consumed > maxBytes) {
          controller.error(new PayloadTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    });

    const cappedBody = request.body.pipeThrough(transform);

    // Build a new Request with the capped stream. We clone headers,
    // method, signal etc. — only the body is replaced.
    const cappedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: cappedBody,
      signal: request.signal,
      // @ts-expect-error -- `duplex` is required for streaming bodies
      // in undici / Node 18+ but not yet in the TS DOM types.
      duplex: "half",
    });

    try {
      return await handler(cappedRequest, context);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return new Response(
          JSON.stringify({
            error: `Payload příliš velký. Limit je ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`,
          }),
          {
            status: 413,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      // Re-throw unrelated errors.
      throw err;
    }
  };
}
