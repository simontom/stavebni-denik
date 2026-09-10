import { describe, expect, it } from "vitest";

import { withBodyLimit, PayloadTooLargeError } from "@/server/with-body-limit";

/**
 * Unit tests for the `withBodyLimit` route-handler wrapper.
 *
 * All tests run in Node.js where the Web Streams API and `Request` /
 * `Response` globals are available natively (Node 18+).
 */

const LIMIT = 100; // tiny limit makes tests fast

/**
 * Build a minimal Request with the given body bytes and an optional
 * spoofed Content-Length header.
 */
function makeRequest(
  body: Uint8Array | null,
  options: { contentLength?: number } = {},
): Request {
  const headers = new Headers({ "content-type": "application/octet-stream" });
  if (options.contentLength !== undefined) {
    headers.set("content-length", String(options.contentLength));
  }
  return new Request("http://localhost/test", {
    method: body ? "POST" : "GET",
    headers,
    // Cast to satisfy lib.dom BodyInit — Node 18+ accepts Uint8Array
    // but the TS DOM lib still expects ArrayBufferView via BufferSource.
    body: body as BodyInit | null,
    ...(body ? { duplex: "half" } : {}),
  });
}

/** A handler that echoes the body back as text so we can verify passthrough. */
async function echoHandler(request: Request): Promise<Response> {
  const text = await request.text();
  return new Response(text, { status: 200 });
}

describe("withBodyLimit", () => {
  it("passes request through when body is within the limit", async () => {
    const body = new Uint8Array(LIMIT); // exactly at the limit
    const handler = withBodyLimit(LIMIT, echoHandler);
    const res = await handler(makeRequest(body));
    expect(res.status).toBe(200);
  });

  it("returns 413 when Content-Length header honestly declares an oversized body", async () => {
    const handler = withBodyLimit(LIMIT, echoHandler);
    // Body itself is small, but Content-Length is honest about being over.
    const body = new Uint8Array(5);
    const res = await handler(makeRequest(body, { contentLength: LIMIT + 1 }));
    expect(res.status).toBe(413);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("MB");
  });

  it("returns 413 when actual stream exceeds the limit even with spoofed Content-Length", async () => {
    const handler = withBodyLimit(LIMIT, echoHandler);
    // Attacker lies about Content-Length = 0 but sends LIMIT+1 bytes.
    const body = new Uint8Array(LIMIT + 1);
    const res = await handler(makeRequest(body, { contentLength: 0 }));
    expect(res.status).toBe(413);
  });

  it("passes through requests with no body (GET)", async () => {
    const handler = withBodyLimit(LIMIT, async () =>
      new Response("ok", { status: 200 }),
    );
    const req = makeRequest(null);
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it("does not swallow unrelated errors from the handler", async () => {
    const handler = withBodyLimit(LIMIT, async () => {
      throw new Error("unrelated");
    });
    const body = new Uint8Array(1);
    await expect(handler(makeRequest(body))).rejects.toThrow("unrelated");
  });

  it("exposes PayloadTooLargeError for callers that need to inspect it", () => {
    const err = new PayloadTooLargeError(1024 * 1024);
    expect(err.code).toBe("PayloadTooLarge");
    expect(err.message).toContain("1");
  });
});
