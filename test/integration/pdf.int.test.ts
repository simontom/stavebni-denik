import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFooterTemplate, renderPdf } from "@/server/pdf";

/**
 * Smoke test for the Playwright-backed PDF wrapper. Lives in the
 * integration suite (rather than co-located in `src/`) because it
 * requires the chromium binary that `pnpm exec playwright install
 * chromium` puts in `~/Library/Caches/ms-playwright` (or the Linux
 * equivalent). The CI integration job installs chromium explicitly;
 * the dev-loop `pnpm test` stays fast and doesn't pay the price.
 *
 * The test catches the common breakages:
 *
 *  - chromium binary missing / not downloaded,
 *  - playwright API mismatch with our PDF options,
 *  - the wrapper not actually returning a PDF (we check the magic
 *    bytes `%PDF-`).
 */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><body><h1>Test PDF</h1>" +
          "<p>Ahoj z testu počasí ě š č ř ž</p>" +
          "</body></html>",
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}/`;
      resolve();
    });
  });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("renderPdf — Playwright smoke", () => {
  it("renders an A4 PDF from a static HTML page", async () => {
    const pdf = await renderPdf({ url: baseUrl, cookieHeader: null });
    expect(pdf.length).toBeGreaterThan(500);
    // Every PDF file starts with '%PDF-' (0x25 0x50 0x44 0x46 0x2D).
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 60_000);

  it("buildFooterTemplate scrubs anything non-alphanumeric from the hash", () => {
    const html = buildFooterTemplate("abc<script>1+2");
    expect(html).not.toContain("<script");
    expect(html).toContain("abcscript12");
  });
});
