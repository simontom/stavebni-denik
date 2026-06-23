import { NextResponse } from "next/server";

import { auth } from "@/server/auth";
import type { SessionUser } from "@/server/permissions";
import { getProjectForUser } from "@/server/services/projects";
import { buildProjectCsv, type CsvType } from "@/server/services/csv";

/**
 * `GET /api/projects/[id]/export.csv?type=reports|materials|visits[&from=&to=]`
 *
 * Thin wrapper: auth + authorization + content-disposition headers.
 * All CSV building (DB queries, escaping) lives in `services/csv.ts`
 * so it can be unit-tested without going through next-auth.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_TYPES = new Set<CsvType>(["reports", "materials", "visits"]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  const user = session?.user as SessionUser | undefined;
  if (!user) return new Response("Not found", { status: 404 });

  const { id } = await context.params;
  const project = await getProjectForUser(id, user);
  if (!project) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const typeRaw = (url.searchParams.get("type") ?? "reports") as CsvType;
  if (!ALLOWED_TYPES.has(typeRaw)) {
    return new Response("Unknown type. Allowed: reports, materials, visits", {
      status: 400,
    });
  }

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const from =
    fromRaw && DATE_RE.test(fromRaw) ? new Date(`${fromRaw}T00:00:00Z`) : null;
  const to =
    toRaw && DATE_RE.test(toRaw) ? new Date(`${toRaw}T23:59:59Z`) : null;

  const body = await buildProjectCsv({
    projectId: id,
    type: typeRaw,
    from,
    to,
  });

  const filename = `${project.project.name.replace(/[^a-zA-Z0-9-_]/g, "_")}_${typeRaw}_${
    new Date().toISOString().slice(0, 10)
  }.csv`;

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
