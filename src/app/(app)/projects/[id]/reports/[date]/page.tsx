import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, CloudSun, FilePlus2, ImageIcon, Lock, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatDateInput, formatDateTime, pragueDayStart } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import { canCreateReport, getReportForUser } from "@/server/services/reports";
import { listPhotosForReport } from "@/server/services/photos";
import { listVisitsForReport } from "@/server/services/visits";

import { AddendumForm } from "../AddendumForm";
import { DeletePhotoButton } from "../DeletePhotoButton";
import { PhotoUploader } from "../PhotoUploader";
import { ReportForm } from "../ReportForm";
import { EMPTY_REPORT_VALUES } from "../report-form-types";
import { SignReportButton } from "../SignReportButton";
import { VisitsPanel } from "../VisitsPanel";
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

  const { report, weather, workers, remarks, materials, addenda, locked } =
    detail;
  const photos = await listPhotosForReport({ reportId: report.id, user });
  const visits = await listVisitsForReport(report.id);
  const canUploadPhotos =
    (user.role === "BOSS" || user.role === "WORKER") &&
    detail.isMember &&
    !locked;
  const canDeletePhotos = user.role === "BOSS" && detail.isMember && !locked;

  // Návštěvy: smazat smí BOSS (vždy, pokud member) nebo autor (pokud member).
  // GUEST nesmí mazat ani vlastní (jednou napsáno = audit-stable). Vstup
  // disabled gate je nezávislý na canDelete — i locked report skryje formulář.
  const canDeleteVisitFor = (authorId: string): boolean => {
    if (!detail.isMember || locked) return false;
    if (user.role === "BOSS") return true;
    if (user.role === "WORKER") return authorId === user.id;
    return false;
  };
  const visitItems = visits.map((v) => ({
    id: v.id,
    visitorName: v.visitorName,
    visitorRole: v.visitorRole,
    organization: v.organization,
    visitedAt: v.visitedAt,
    purpose: v.purpose,
    notes: v.notes,
    authorName: v.authorName,
    canDelete: canDeleteVisitFor(v.authorId),
  }));
  const canRecordVisit = detail.isMember && !locked;

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
            {locked && detail.signedByName && report.signedAt && (
              <>
                {" · podepsal "}
                {detail.signedByName}
                {" "}
                ({formatDateTime(report.signedAt)})
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.canEdit && (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/projects/${id}/reports/${dateStr}/edit`} />}
            >
              <Pencil className="size-4" aria-hidden /> Upravit
            </Button>
          )}
          {detail.canSign && (
            <SignReportButton
              reportId={report.id}
              projectId={id}
              date={dateStr}
            />
          )}
        </div>
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
            <RemarkForm
              reportId={report.id}
              projectId={id}
              date={dateStr}
              showOfficialOption={detail.canMarkRemarkOfficial}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Návštěvy a kontroly ({visits.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <VisitsPanel
            projectId={id}
            dateStr={dateStr}
            reportId={report.id}
            items={visitItems}
            disabled={!canRecordVisit}
          />
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
            canRollover={detail.canRolloverMaterial}
            rolloverTargets={detail.rolloverTargets.map((t) => ({
              date: formatDateInput(t.date),
              label: formatDate(t.date),
            }))}
            items={materials.map((m) => ({
              id: m.id,
              text: m.text,
              neededBy: m.neededBy ? m.neededBy.toISOString() : null,
              resolved: m.resolved,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="size-4" aria-hidden /> Fotografie ({photos.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {photos.length === 0 ? (
            <p className="text-sm text-muted-foreground">Žádné fotografie.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {photos.map((p, i) => {
                const captionParts: string[] = [`Fotka ${i + 1}`];
                if (p.capturedAt) {
                  captionParts.push(`pořízeno ${formatDateTime(p.capturedAt)}`);
                }
                captionParts.push(`nahrál ${p.uploadedByName}`);
                const caption = captionParts.join(" · ");
                return (
                  <li
                    key={p.id}
                    className="group relative aspect-square overflow-hidden rounded-md border"
                  >
                    <a
                      href={`/api/photos/${p.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block h-full w-full"
                      title={caption}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/photos/${p.id}?variant=thumb`}
                        alt={caption}
                        loading="lazy"
                        className="h-full w-full object-cover transition group-hover:scale-105"
                      />
                    </a>
                    {canDeletePhotos && (
                      <div className="absolute top-1 right-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
                        <DeletePhotoButton
                          photoId={p.id}
                          projectId={id}
                          date={dateStr}
                          caption={`#${i + 1}`}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canUploadPhotos && <PhotoUploader reportId={report.id} />}
        </CardContent>
      </Card>

      {(addenda.length > 0 || detail.canAddAddendum) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FilePlus2 className="size-4" aria-hidden /> Dodatky ({addenda.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {addenda.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Záznam je podepsaný a uzamčený. Případné opravy přidejte jako
                dodatek — původní obsah dne se tím nepřepíše.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {addenda.map((a) => (
                  <li key={a.id} className="grid gap-0.5 border-b pb-3 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{a.authorName}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(a.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{a.text}</p>
                  </li>
                ))}
              </ul>
            )}
            {detail.canAddAddendum && (
              <AddendumForm
                reportId={report.id}
                projectId={id}
                date={dateStr}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
