import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { formatDate, pragueDayStart } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import { getReportForUser } from "@/server/services/reports";

import { ReportForm } from "../../ReportForm";
import type { ReportFormValues } from "../../report-form-types";
import { updateReportAction } from "../../actions";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PageProps {
  params: Promise<{ id: string; date: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { date } = await params;
  return { title: `Úprava denního záznamu ${date}` };
}

function weekdayLabel(date: Date): string {
  const wd = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    weekday: "long",
  }).format(date);
  return `${wd} ${formatDate(date)}`;
}

export default async function EditReportPage({ params }: PageProps) {
  const user = await requireUser();
  const { id, date: dateStr } = await params;
  if (!DATE_RE.test(dateStr)) notFound();

  const date = pragueDayStart(dateStr);
  const detail = await getReportForUser({ projectId: id, date, user });
  if (!detail || !detail.canEdit) notFound();

  const { report, workers } = detail;

  const defaultValues: ReportFormValues = {
    workersByTrade: workers.map((w) => ({
      trade: w.trade,
      count: String(w.count),
    })),
    workDescription: report.workDescription,
    materialsIn: report.materialsIn ?? "",
    machinery: report.machinery ?? "",
    testsAndChecks: report.testsAndChecks ?? "",
    safetyNotes: report.safetyNotes ?? "",
    defects: report.defects ?? "",
    otherNotes: report.otherNotes ?? "",
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link
        href={`/projects/${id}/reports/${dateStr}`}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden /> Zpět na záznam
      </Link>

      <div>
        <h1 className="text-xl font-semibold">Úprava denního záznamu</h1>
        <p className="text-sm text-muted-foreground">{weekdayLabel(date)}</p>
      </div>

      <ReportForm
        action={updateReportAction.bind(null, report.id, id, dateStr)}
        defaultValues={defaultValues}
        submitLabel="Uložit změny"
        cancelHref={`/projects/${id}/reports/${dateStr}`}
      />
    </div>
  );
}
