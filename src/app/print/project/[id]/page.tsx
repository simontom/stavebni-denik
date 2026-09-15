import { notFound } from "next/navigation";

import { formatDate, pragueDayStart } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import { getProjectForUser } from "@/server/services/projects";
import { getProjectExportForUser } from "@/server/services/reports";

import { PrintCoverPage } from "./_components/PrintCoverPage";
import { PrintDailyRecord } from "./_components/PrintDailyRecord";
import { PrintStyles } from "./_components/PrintStyles";

/**
 * Print-friendly server-rendered view of a project's daily diary, used
 * by the Playwright PDF wrapper. Never linked in the regular UI — the
 * user-facing flow is the "Stáhnout PDF" button on /projects/[id]
 * which calls /api/projects/[id]/pdf; that route then loads this page
 * in headless Chromium.
 *
 * The root layout already provides html/body/font so we render only
 * the print content + an inline <style> that overrides the screen
 * stylesheet inside @page bounds.
 */

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readDate(value: string | string[] | undefined): Date | null {
  const v = typeof value === "string" ? value : null;
  if (!v || !DATE_RE.test(v)) return null;
  return pragueDayStart(v);
}

export default async function PrintProjectPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;

  const project = await getProjectForUser(id, user);
  if (!project) notFound();

  const from = readDate(sp.from);
  const to = readDate(sp.to);
  const exportData = await getProjectExportForUser({
    projectId: id,
    from,
    to,
    user,
  });
  if (!exportData) notFound();

  const days = exportData.days;
  const dateRangeLabel =
    from && to
      ? `${formatDate(from)} – ${formatDate(to)}`
      : from
        ? `od ${formatDate(from)}`
        : to
          ? `do ${formatDate(to)}`
          : "celé období";

  return (
    <>
      <PrintStyles />
      <div id="print-root">
        <PrintCoverPage
          project={project.project}
          dateRangeLabel={dateRangeLabel}
          daysCount={days.length}
        />

        {days.length === 0 ? (
          <p className="empty">V daném období nejsou žádné denní záznamy.</p>
        ) : (
          days.map((day, i) => <PrintDailyRecord key={day.id} day={day} pageBreakBefore={i > 0} />)
        )}
      </div>
    </>
  );
}
