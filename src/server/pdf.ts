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
 *
 * Calls are serialised through an in-process semaphore (default
 * concurrency = 1, override via `PDF_RENDER_CONCURRENCY`). On a 1 GB
 * Fly machine two parallel Chromium instances trip the OOM killer
 * almost every time — queueing is a single line of business logic
 * that buys us the same protection a full job broker would, without
 * any external infrastructure.
 */
export async function renderPdf(opts: RenderPdfOptions): Promise<Buffer> {
  return acquirePdfSlot(() => renderPdfNow(opts));
}

async function renderPdfNow(opts: RenderPdfOptions): Promise<Buffer> {
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

// ---------------------------------------------------------------------------
// In-process render queue (OOM protection on 1 GB Fly)
// ---------------------------------------------------------------------------

const PDF_CONCURRENCY = readPdfConcurrency();

/**
 * Parse `PDF_RENDER_CONCURRENCY` into a positive integer. The default
 * matches the safest setting on a 1 GB shared-cpu-1x machine: one
 * Chromium at a time. Set to 2+ once the box has at least 2 GB or
 * the workload is dominated by network waits rather than RAM.
 */
function readPdfConcurrency(): number {
  const raw = process.env.PDF_RENDER_CONCURRENCY;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Run `task` once a render slot is available. The semaphore is module
 * state — one queue per Node process. That matches the Next.js
 * standalone deployment: a single server.js worker handles every
 * request, so there's no other Chromium racing for memory.
 *
 * Exposed only so the unit test can drive it directly; production
 * callers go through `renderPdf`.
 */
export async function acquirePdfSlot<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= PDF_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight += 1;
  try {
    return await task();
  } finally {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

/** For tests + observability: how many renders are queued (not yet running). */
export function getPdfQueueDepth(): number {
  return waiters.length;
}

/** For tests + observability: how many renders are currently running. */
export function getPdfInFlight(): number {
  return inFlight;
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
