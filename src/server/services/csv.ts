import "server-only";

import { prisma } from "@/lib/db";
import { csvRow, CSV_BOM } from "@/lib/csv";
import { formatDateInput, formatDateTime } from "@/lib/dates";

export type CsvType = "reports" | "materials" | "visits";

interface BuildOptions {
  projectId: string;
  type: CsvType;
  from?: Date | null;
  to?: Date | null;
}

/**
 * Build the full CSV body (BOM + header + rows) for a project's
 * dataset. Pure function from DB read perspective — caller owns
 * authorisation (route checks `getProjectForUser`).
 */
export async function buildProjectCsv({
  projectId,
  type,
  from,
  to,
}: BuildOptions): Promise<string> {
  let body = CSV_BOM;

  if (type === "reports") {
    body += csvRow([
      "Datum",
      "Autor",
      "Pracovníci celkem",
      "Podepsáno",
      "Podepsal",
      "Podepsáno v",
      "Popis prací",
      "Dodávky materiálu",
      "Mechanizace",
      "Zkoušky a měření",
      "BOZP",
      "Závady",
      "Ostatní",
    ]);
    const reports = await prisma.dailyReport.findMany({
      where: {
        projectId,
        deletedAt: null,
        ...(from || to
          ? {
              date: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { date: "asc" },
      include: {
        author: { select: { displayName: true } },
        signedBy: { select: { displayName: true } },
      },
    });
    for (const r of reports) {
      const totalWorkers = Array.isArray(r.workersByTrade)
        ? (r.workersByTrade as Array<{ count?: number }>).reduce(
            (s, w) => s + (typeof w.count === "number" ? w.count : 0),
            0,
          )
        : 0;
      body += csvRow([
        formatDateInput(r.date),
        r.author.displayName,
        totalWorkers,
        r.signedAt ? "ano" : "ne",
        r.signedBy?.displayName ?? "",
        r.signedAt ? formatDateTime(r.signedAt) : "",
        r.workDescription,
        r.materialsIn ?? "",
        r.machinery ?? "",
        r.testsAndChecks ?? "",
        r.safetyNotes ?? "",
        r.defects ?? "",
        r.otherNotes ?? "",
      ]);
    }
    return body;
  }

  if (type === "materials") {
    body += csvRow([
      "Datum reportu",
      "Položka",
      "Potřeba do",
      "Stav",
      "Vyřízeno v",
    ]);
    const rows = await prisma.materialNeed.findMany({
      where: {
        report: {
          projectId,
          deletedAt: null,
          ...(from || to
            ? {
                date: {
                  ...(from ? { gte: from } : {}),
                  ...(to ? { lte: to } : {}),
                },
              }
            : {}),
        },
        deletedAt: null,
      },
      orderBy: [{ report: { date: "asc" } }, { neededBy: "asc" }],
      include: { report: { select: { date: true } } },
    });
    for (const m of rows) {
      body += csvRow([
        formatDateInput(m.report.date),
        m.text,
        m.neededBy ? formatDateInput(m.neededBy) : "",
        m.resolved ? "vyřízeno" : "otevřené",
        m.resolvedAt ? formatDateTime(m.resolvedAt) : "",
      ]);
    }
    return body;
  }

  // visits
  body += csvRow([
    "Datum reportu",
    "Čas návštěvy",
    "Jméno",
    "Role",
    "Organizace",
    "Účel",
    "Poznámka",
    "Zapsal",
  ]);
  const rows = await prisma.visit.findMany({
    where: {
      report: {
        projectId,
        deletedAt: null,
        ...(from || to
          ? {
              date: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      deletedAt: null,
    },
    orderBy: [{ report: { date: "asc" } }, { visitedAt: "asc" }],
    include: {
      report: { select: { date: true } },
      author: { select: { displayName: true } },
    },
  });
  for (const v of rows) {
    body += csvRow([
      formatDateInput(v.report.date),
      formatDateTime(v.visitedAt),
      v.visitorName,
      v.visitorRole,
      v.organization ?? "",
      v.purpose,
      v.notes ?? "",
      v.author.displayName,
    ]);
  }
  return body;
}
