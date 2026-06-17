import "server-only";

import { chromium } from "playwright";

/**
 * Headless-Chromium PDF wrapper.
 *
 * Chromium is the only browser engine that renders our print stylesheet
 * the way we expect (page-break-inside, page-break-before etc.), so we
 * go through Playwright rather than a server-side PDF lib like pdfkit
 * or pdf-lib that would re-implement the layout.
 *
 * The chromium binary is downloaded at install time via
 * `pnpm exec playwright install chromium`; in production the Dockerfile
 * runner stage is responsible for the same step.
 */

const A4_MARGIN = {
  top: "22mm",
  bottom: "22mm",
  left: "15mm",
  right: "15mm",
};

const NAV_TIMEOUT_MS = 60_000;

export interface RenderPdfOptions {
  /** Absolute URL of the auth-gated print route to navigate to. */
  url: string;
  /**
   * `cookie` header value forwarded into the headless browser context
   * so the print page sees the same session as the user requesting the
   * PDF. Pass the raw `request.headers.get("cookie")`.
   */
  cookieHeader: string | null;
  /**
   * Optional per-page HTML footer. Use minimal inline styles — Chromium
   * print templates do NOT see the document's stylesheet. The audit row
   * hash for the export is plumbed in here so every page carries a
   * tamper-evidence anchor.
   */
  footerHtml?: string;
}

/**
 * Render the given URL to an A4 PDF buffer. Cleans up the browser even
 * when navigation / rendering throws, so a single failure doesn't leak
 * chromium processes.
 */
export async function renderPdf(opts: RenderPdfOptions): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      // Match modern desktop viewport so server-rendered components
      // pick the same breakpoint they would in a regular browser.
      viewport: { width: 1280, height: 1696 },
      extraHTTPHeaders: opts.cookieHeader
        ? { cookie: opts.cookieHeader }
        : undefined,
    });
    const page = await context.newPage();
    await page.goto(opts.url, {
      waitUntil: "networkidle",
      timeout: NAV_TIMEOUT_MS,
    });

    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: Boolean(opts.footerHtml),
      headerTemplate: "<span></span>",
      footerTemplate:
        opts.footerHtml ??
        '<div style="width:100%;font-size:8px;text-align:center;color:#666;padding:0 10mm;">' +
          '<span class="pageNumber"></span>/<span class="totalPages"></span>' +
          "</div>",
      margin: A4_MARGIN,
    });
    return buffer;
  } finally {
    await browser.close();
  }
}

/**
 * Build the footer template that goes on every page: page X/Y on the
 * right, audit-row hash anchor on the left so the PDF is auditable
 * back to the exact log row that was the latest entry at export time.
 */
export function buildFooterTemplate(auditHashShort: string): string {
  // Chromium's footer/header is rendered separately from the document
  // stylesheet, so we inline everything.
  const safeHash = auditHashShort.replace(/[^a-zA-Z0-9]/g, "");
  return (
    '<div style="width:100%;font-size:8px;color:#555;padding:0 12mm;display:flex;justify-content:space-between;">' +
    `<span>audit ${safeHash}</span>` +
    '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>' +
    "</div>"
  );
}
