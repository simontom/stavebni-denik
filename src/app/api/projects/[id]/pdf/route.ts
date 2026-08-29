import { auth } from "@/server/auth";
import { buildFooterTemplate, renderPdf } from "@/server/pdf";
import { env } from "@/lib/env";
import { appendAudit, getLatestAuditHash } from "@/server/audit";
import { getAuditContext } from "@/server/audit-context";
import { formatDateInput } from "@/lib/dates";
import type { SessionUser } from "@/server/permissions";
import { PDF_RENDER_USER_LIMIT, checkRateLimit } from "@/server/rate-limit";
import { getProjectForUser } from "@/server/services/projects";
import { logger } from "@/lib/logger";

/**
 * `GET /api/projects/[id]/pdf?from=&to=`
 *
 * Spawns headless Chromium against `/print/project/[id]` with the
 * caller's cookies forwarded, renders an A4 PDF and streams it back.
 * The per-page footer carries the truncated `rowHash` of the latest
 * audit log entry at export time, anchoring the document to the
 * tamper-evident chain.
 *
 * Authorisation mirrors the print page: any project member can export
 * (BOSS sees every project unconditionally). Out-of-scope callers get
 * 404 to avoid existence leaks.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// PDF generation can take several seconds for big projects with many
// photos — give it room.
export const maxDuration = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  const user = session?.user as SessionUser | undefined;
  if (!user) {
    return new Response("Not found", { status: 404 });
  }

  const { id } = await context.params;
  const project = await getProjectForUser(id, user);
  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  // Throttle per user — PDF rendering spawns Chromium and is by far
  // the most expensive operation in the app. PDF queue serialises
  // the *work*; this rate limit caps the *queue depth*.
  const limit = await checkRateLimit({ ...PDF_RENDER_USER_LIMIT, key: user.id });
  if (!limit.allowed) {
    logger.warn("pdf.rate_limited", { userId: user.id, projectId: id });
    const retrySeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return new Response("Příliš mnoho exportů — zkuste to za chvíli znovu.", {
      status: 429,
      headers: { "Retry-After": String(retrySeconds) },
    });
  }

  const reqUrl = new URL(request.url);
  const from = reqUrl.searchParams.get("from") ?? "";
  const to = reqUrl.searchParams.get("to") ?? "";
  const printUrl = new URL(`/print/project/${id}`, env.authUrl);
  if (DATE_RE.test(from)) printUrl.searchParams.set("from", from);
  if (DATE_RE.test(to)) printUrl.searchParams.set("to", to);

  const latestHash = await getLatestAuditHash();
  const footerHtml = buildFooterTemplate(latestHash.slice(0, 16));

  let pdf: Buffer;
  try {
    pdf = await renderPdf({
      url: printUrl.toString(),
      cookieHeader: request.headers.get("cookie"),
      footerHtml,
    });
  } catch {
    // pdf.ts already logs pdf.error
    return new Response("PDF generation failed", { status: 500 });
  }

  // Audit the export AFTER the render succeeds — we only want
  // entries for real, delivered downloads. The audit row anchors
  // the PDF: { project, range, bytes, latestHash at export time }
  // is enough to prove WHAT data was rendered (a re-render with the
  // same project + range + identical DB state will produce the same
  // footer hash, hence the same content). No PDF blob is persisted
  // — the hash chain alone is the evidence.
  try {
    const ctx = await getAuditContext();
    await appendAudit(ctx, {
      action: "pdf.export",
      entityType: "project",
      entityId: id,
      after: {
        projectName: project.project.name,
        from: DATE_RE.test(from) ? from : null,
        to: DATE_RE.test(to) ? to : null,
        bytes: pdf.length,
        // Truncated form matches what we burn into the PDF footer —
        // so a recipient can cross-check the file against this row.
        anchorHash: latestHash.slice(0, 16),
        latestHashFull: latestHash,
      },
    });
  } catch (err) {
    // Never block a successful download on an audit append failure
    // (e.g. transient DB hiccup) — log and continue.
    logger.error("[pdf.export] audit append failed", err);
  }

  const safeName = project.project.name.replace(/[^\p{L}\p{N}_-]+/gu, "_");
  const today = formatDateInput(new Date());
  const filename = `stavebni-denik-${safeName}-${today}.pdf`;

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
