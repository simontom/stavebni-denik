import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, CloudSun, Lock, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatDateTime, pragueDayStart } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import { canCreateReport, getReportForUser } from "@/server/services/reports";

import { ReportForm } from "../ReportForm";
import { EMPTY_REPORT_VALUES } from "../report-form-types";
import { createReportAction } from "../actions";
import { ManualWeatherForm, MaterialsPanel, RemarkForm } from "../ReportPanels";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PageProps {
  params: Promise<{ id: string; date: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { date } = await params;
  return { title: `Denní záznam ${date}` };
}

/** Czech weekday + date label, e.g. "úterý 16.06.2026". */
function weekdayLabel(date: Date): string {
  const wd = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    weekday: "long",
  }).format(date);
  return `${wd} ${formatDate(date)}`;
}

function Section({ title, value }: { title: string; value: string | null }) {
  if (!value || value.trim().length === 0) return null;
  return (
    <div className="grid gap-1 border-b py-3 last:border-b-0">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-sm whitespace-pre-wrap text-muted-foreground">{value}</p>
    </div>
  );
}

export default async function ReportPage({ params }: PageProps) {
  const user = await requireUser();
  const { id, date: dateStr } = await params;
  if (!DATE_RE.test(dateStr)) notFound();

  const date = pragueDayStart(dateStr);
  const detail = await getReportForUser({ projectId: id, date, user });

  const backLink = (
    <Link
      href={`/projects/${id}?tab=reports`}
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-4" aria-hidden /> Zpět na záznamy
    </Link>
  );

  // No report yet — offer the create form to those allowed, else 404.
  if (!detail) {
    const allowed = await canCreateReport(id, user);
    if (!allowed) notFound();

    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {backLink}
        <div>
          <h1 className="text-xl font-semibold">Nový denní záznam</h1>
          <p className="text-sm text-muted-foreground">{weekdayLabel(date)}</p>
        </div>
        <ReportForm
          action={createReportAction.bind(null, id, dateStr)}
          defaultValues={EMPTY_REPORT_VALUES}
          submitLabel="Vytvořit záznam"
          cancelHref={`/projects/${id}?tab=reports`}
        />
      </div>
    );
  }

  const { report, weather, workers, remarks, materials, locked } = detail;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {backLink}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{weekdayLabel(date)}</h1>
            {locked && (
              <Badge variant="secondary">
                <Lock className="size-3" aria-hidden /> Podepsáno
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {detail.projectName} · zapsal {detail.authorName}
          </p>
        </div>
        {detail.canEdit && (
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/projects/${id}/reports/${dateStr}/edit`} />}
          >
            <Pencil className="size-4" aria-hidden /> Upravit
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CloudSun className="size-4" aria-hidden /> Počasí
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm">{weather.summary}</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            {weather.tempMinC !== null && weather.tempMaxC !== null && (
              <span>
                Teplota: {weather.tempMinC}–{weather.tempMaxC} °C
              </span>
            )}
            {weather.precipitationMm !== null && (
              <span>Srážky: {weather.precipitationMm} mm</span>
            )}
            {weather.windMaxKmh !== null && (
              <span>Vítr: {weather.windMaxKmh} km/h</span>
            )}
          </div>
          {weather.source === "open-meteo" && (
            <p className="text-xs text-muted-foreground">
              Zdroj: Open-Meteo, {formatDateTime(weather.fetchedAt)}
            </p>
          )}
          {weather.source === "manual" && (
            <p className="text-xs text-muted-foreground">Zadáno ručně.</p>
          )}
          {weather.source === "unavailable" && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-destructive">
                {weather.error ?? "Počasí se nepodařilo načíst."}
              </p>
              {detail.canEdit && !locked && (
                <ManualWeatherForm
                  reportId={report.id}
                  projectId={id}
                  date={dateStr}
                  defaultSummary=""
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pracovníci</CardTitle>
        </CardHeader>
        <CardContent>
          {workers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Neuvedeno.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {workers.map((w, i) => (
                <li key={i} className="flex justify-between border-b py-1 last:border-b-0">
                  <span>{w.trade}</span>
                  <span className="text-muted-foreground">{w.count}</span>
                </li>
              ))}
              <li className="flex justify-between pt-1 font-medium">
                <span>Celkem</span>
                <span>{workers.reduce((s, w) => s + w.count, 0)}</span>
              </li>
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Průběh prací</CardTitle>
        </CardHeader>
        <CardContent>
          <Section title="Popis provedených prací" value={report.workDescription} />
          <Section title="Dodávky materiálu" value={report.materialsIn} />
          <Section title="Nasazená mechanizace" value={report.machinery} />
          <Section title="Zkoušky a měření" value={report.testsAndChecks} />
          <Section title="BOZP" value={report.safetyNotes} />
          <Section title="Závady a nedodělky" value={report.defects} />
          <Section title="Ostatní" value={report.otherNotes} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Připomínky ({remarks.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {remarks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Žádné připomínky.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {remarks.map((r) => (
                <li key={r.id} className="grid gap-0.5 border-b pb-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.authorName}</span>
                    {r.isOfficial && <Badge variant="secondary">Oficiální</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(r.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{r.text}</p>
                </li>
              ))}
            </ul>
          )}
          {detail.canAddRemark && (
            <RemarkForm reportId={report.id} projectId={id} date={dateStr} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Materiál na další dny</CardTitle>
        </CardHeader>
        <CardContent>
          <MaterialsPanel
            reportId={report.id}
            projectId={id}
            date={dateStr}
            canAdd={detail.canAddMaterial}
            canResolve={detail.canResolveMaterial}
            items={materials.map((m) => ({
              id: m.id,
              text: m.text,
              neededBy: m.neededBy ? m.neededBy.toISOString() : null,
              resolved: m.resolved,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
