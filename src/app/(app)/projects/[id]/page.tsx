import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CalendarDays,
  ChevronLeft,
  CloudSun,
  ImageIcon,
  Lock,
  MessageSquare,
  Package,
  Pencil,
  UserCheck,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatDateInput } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import {
  getProjectForUser,
  getProjectStats,
  listAddableUsers,
  listMaterialsForProject,
} from "@/server/services/projects";
import {
  canCreateReport,
  getReportCoverageForProject,
  listReportsForProject,
} from "@/server/services/reports";

import { MembersPanel } from "./MembersPanel";
import { NewReportDayPicker } from "./NewReportDayPicker";
import { PdfExportForm } from "./PdfExportForm";
import { CsvExportButtons } from "./CsvExportButtons";
import { MaterialGantt } from "./MaterialGantt";
import { ProjectStatusButton } from "./ProjectStatusButton";
import { ReportCalendarMonth } from "./ReportCalendarMonth";
import { ReportCoverageHeatmap } from "./ReportCoverageHeatmap";
import { ReportsFilterBar } from "./ReportsFilterBar";

type ProjectTab = "details" | "reports" | "materials" | "members";

function resolveTab(value: string | string[] | undefined): ProjectTab {
  if (value === "reports") return "reports";
  if (value === "materials") return "materials";
  if (value === "members") return "members";
  return "details";
}

type ReportStatusFilter = "all" | "signed" | "unsigned";

function resolveStatus(
  value: string | string[] | undefined,
): ReportStatusFilter {
  if (value === "signed") return "signed";
  if (value === "unsigned") return "unsigned";
  return "all";
}

function readQuery(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "";
  // Cap free-text length to keep the URL sane.
  return value.slice(0, 200).trim();
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Returns the first UTC day of the (year, month) at midnight. */
function monthAnchorFromParam(
  value: string | string[] | undefined,
  fallback: Date,
): Date {
  if (typeof value === "string") {
    const m = MONTH_RE.exec(value);
    if (m) {
      const year = Number(m[1]);
      const monthIdx = Number(m[2]) - 1;
      if (year >= 2000 && year < 2100 && monthIdx >= 0 && monthIdx <= 11) {
        return new Date(Date.UTC(year, monthIdx, 1));
      }
    }
  }
  return new Date(
    Date.UTC(fallback.getFullYear(), fallback.getMonth(), 1),
  );
}

/** "YYYY-MM" param string for the month containing `d`. */
function monthParam(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const user = await requireUser();
  const { id } = await params;
  const detail = await getProjectForUser(id, user);
  return { title: detail ? detail.project.name : "Zakázka" };
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="grid gap-0.5 border-b py-2 last:border-b-0 sm:grid-cols-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm sm:col-span-2">{value && value.length > 0 ? value : "—"}</dd>
    </div>
  );
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: PageProps) {
  const user = await requireUser();
  const { id } = await params;

  // Project access check and the lightweight header statistics are
  // independent reads keyed only by `id`, so run them in parallel to save
  // a DB round-trip on every render. `getProjectStats` is cheap (counts only)
  // and its result is simply discarded if access is denied below.
  const [detail, stats] = await Promise.all([
    getProjectForUser(id, user),
    getProjectStats(id),
  ]);
  if (!detail) notFound();

  const { project, members, canManage } = detail;
  const sp = await searchParams;
  const tab = resolveTab(sp.tab);
  const archived = project.deletedAt !== null;

  const addableUsers = canManage && !archived ? await listAddableUsers(id) : [];
  const reportsQuery = readQuery(sp.q);
  const reportsStatus = resolveStatus(sp.status);
  const filteredReports =
    tab === "reports"
      ? await listReportsForProject(id, user, {
          q: reportsQuery,
          status: reportsStatus,
        })
      : [];
  const totalReports =
    tab === "reports" && (reportsQuery.length > 0 || reportsStatus !== "all")
      ? (await listReportsForProject(id, user)).length
      : filteredReports.length;
  const canCreate =
    tab === "reports" && !archived ? await canCreateReport(id, user) : false;
  const coverage =
    tab === "reports"
      ? await getReportCoverageForProject({ projectId: id, user })
      : null;

  // Calendar view (current month by default). Bounded fetch — only
  // the visible month, so cheap regardless of project lifetime.
  const today = new Date();
  const calendarAnchor =
    tab === "reports" ? monthAnchorFromParam(sp.month, today) : today;
  const monthEnd =
    tab === "reports"
      ? new Date(
          Date.UTC(
            calendarAnchor.getUTCFullYear(),
            calendarAnchor.getUTCMonth() + 1,
            0,
          ),
        )
      : today;
  const calendarCoverage =
    tab === "reports"
      ? await getReportCoverageForProject({
          projectId: id,
          user,
          from: calendarAnchor,
          to: monthEnd,
        })
      : null;
  const prevMonthParam = monthParam(
    new Date(
      Date.UTC(
        calendarAnchor.getUTCFullYear(),
        calendarAnchor.getUTCMonth() - 1,
        1,
      ),
    ),
  );

  // Materiálový tab data — jen když je tab aktivní A user není GUEST.
  // GUEST nemá vidět ani odkaz, ani fetched data (defence in depth).
  const materials =
    tab === "materials" && user.role !== "GUEST"
      ? await listMaterialsForProject(id)
      : [];
  const nextMonthParam = monthParam(
    new Date(
      Date.UTC(
        calendarAnchor.getUTCFullYear(),
        calendarAnchor.getUTCMonth() + 1,
        1,
      ),
    ),
  );

  const todayDateStr = formatDateInput(new Date());

  const gps =
    project.gpsLat !== null && project.gpsLon !== null
      ? `${project.gpsLat}, ${project.gpsLon}`
      : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/projects"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden /> Zpět na zakázky
        </Link>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{project.name}</CardTitle>
              {archived && <Badge variant="destructive">Archivováno</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">{project.address}</p>
            <p className="text-sm text-muted-foreground">
              Stavbyvedoucí: {project.siteManagerName}
            </p>
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              {!archived && (
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link href={`/projects/${id}/edit`} />}
                >
                  <Pencil className="size-4" aria-hidden /> Upravit
                </Button>
              )}
              <ProjectStatusButton
                projectId={id}
                projectName={project.name}
                archived={archived}
              />
            </div>
          )}
        </CardHeader>
        <CardContent>
          {/* Quick stats — 5 chipů. Click sice neumí filter, jen vizualizace.
              Visible všem rolím (GUEST taky vidí — counts jsou bezpečné). */}
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
              <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden />
              <strong>{stats.reportsTotal}</strong>
              <span className="text-muted-foreground">záznamů</span>
              {stats.reportsLast30Days > 0 && (
                <span className="text-muted-foreground">
                  (
                  {stats.reportsLast30Days} za 30 dní
                  )
                </span>
              )}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
              <Lock className="size-3.5 text-muted-foreground" aria-hidden />
              <strong>{stats.reportsSignedTotal}</strong>
              <span className="text-muted-foreground">podepsaných</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
              <UserCheck className="size-3.5 text-muted-foreground" aria-hidden />
              <strong>{stats.visitsTotal}</strong>
              <span className="text-muted-foreground">návštěv</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
              <ImageIcon className="size-3.5 text-muted-foreground" aria-hidden />
              <strong>{stats.photosTotal}</strong>
              <span className="text-muted-foreground">fotek</span>
            </span>
            {stats.materialsOpen > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 dark:border-amber-900 dark:bg-amber-950/40">
                <Package className="size-3.5 text-amber-700 dark:text-amber-300" aria-hidden />
                <strong>{stats.materialsOpen}</strong>
                <span className="text-amber-800 dark:text-amber-200">
                  otevřených materiálů
                </span>
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <nav className="flex gap-1 border-b" aria-label="Záložky zakázky">
        <Link
          href={`/projects/${id}`}
          className={
            tab === "details"
              ? "border-b-2 border-primary px-3 py-2 text-sm font-medium"
              : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          Údaje stavby
        </Link>
        <Link
          href={`/projects/${id}?tab=reports`}
          className={
            tab === "reports"
              ? "border-b-2 border-primary px-3 py-2 text-sm font-medium"
              : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          Záznamy
        </Link>
        {/* Materiálový tab — skrýt pro Dozor/TDS (GUEST). Tato role
            má číst deník, ale interní materiál checklist firmy ne. */}
        {user.role !== "GUEST" && (
          <Link
            href={`/projects/${id}?tab=materials`}
            className={
              tab === "materials"
                ? "border-b-2 border-primary px-3 py-2 text-sm font-medium"
                : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
          >
            Materiál
          </Link>
        )}
        <Link
          href={`/projects/${id}?tab=members`}
          className={
            tab === "members"
              ? "border-b-2 border-primary px-3 py-2 text-sm font-medium"
              : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          Členové ({members.length})
        </Link>
      </nav>

      {tab === "details" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identifikační údaje stavby</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Název stavby" value={project.name} />
              <DetailRow label="Místo stavby" value={project.address} />
              <DetailRow label="Katastrální území" value={project.cadastralArea} />
              <DetailRow label="Parcelní čísla" value={project.parcelNumbers} />
              <DetailRow
                label="Č. stavebního povolení"
                value={project.permitNumber}
              />
              <DetailRow label="Stavebník" value={project.builder} />
              <DetailRow label="Zhotovitel" value={project.contractor} />
              <DetailRow label="Stavbyvedoucí" value={project.siteManagerName} />
              <DetailRow
                label="Technický dozor stavebníka"
                value={project.tdsName}
              />
              <DetailRow label="Koordinátor BOZP" value={project.bozpName} />
              <DetailRow label="Projektant" value={project.designerName} />
              <DetailRow
                label="Zahájení stavby"
                value={project.startedAt ? formatDate(project.startedAt) : null}
              />
              <DetailRow
                label="Dokončení stavby"
                value={project.endedAt ? formatDate(project.endedAt) : null}
              />
              <DetailRow label="GPS stavby" value={gps} />
            </dl>
          </CardContent>
        </Card>
      )}

      {tab === "reports" && (
        <div className="flex flex-col gap-4">
          {canCreate && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Nový denní záznam</CardTitle>
              </CardHeader>
              <CardContent>
                <NewReportDayPicker
                  projectId={id}
                  todayDateStr={todayDateStr}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Export deníku do PDF</CardTitle>
            </CardHeader>
            <CardContent>
              <PdfExportForm projectId={id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Export tabulek (CSV)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CsvExportButtons projectId={id} />
            </CardContent>
          </Card>

          {coverage && coverage.days.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pokrytí dnů</CardTitle>
              </CardHeader>
              <CardContent>
                <ReportCoverageHeatmap projectId={id} coverage={coverage} />
              </CardContent>
            </Card>
          )}

          {calendarCoverage && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Kalendář</CardTitle>
              </CardHeader>
              <CardContent>
                <ReportCalendarMonth
                  projectId={id}
                  monthAnchor={calendarAnchor}
                  coverage={calendarCoverage}
                  prevMonth={prevMonthParam}
                  nextMonth={nextMonthParam}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Denní záznamy ({filteredReports.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ReportsFilterBar
                projectId={id}
                query={reportsQuery}
                status={reportsStatus}
                totalCount={totalReports}
                filteredCount={filteredReports.length}
              />

              {filteredReports.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {totalReports === 0
                    ? "Zatím žádný denní záznam."
                    : "Žádný záznam neodpovídá filtru."}
                </p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {filteredReports.map((r) => {
                    const dateStr = formatDateInput(r.date);
                    return (
                      <li key={r.id} className="py-3">
                        <Link
                          href={`/projects/${id}/reports/${dateStr}`}
                          className="grid gap-1 hover:underline"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <CalendarDays
                              className="size-4 text-muted-foreground"
                              aria-hidden
                            />
                            <span className="text-sm font-medium">
                              {formatDate(r.date)}
                            </span>
                            {r.signed && (
                              <Badge variant="secondary">
                                <Lock className="size-3" aria-hidden /> Podepsáno
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              · {r.authorName}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Users className="size-3" aria-hidden />
                              {r.workersTotal} pracovníků
                            </span>
                            {r.weatherSummary && (
                              <span className="inline-flex items-center gap-1">
                                <CloudSun className="size-3" aria-hidden />
                                {r.weatherSummary}
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1">
                              <MessageSquare className="size-3" aria-hidden />
                              {r.remarkCount} připomínek
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <ImageIcon className="size-3" aria-hidden />
                              {r.photoCount} fotek
                            </span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "materials" && user.role !== "GUEST" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Materiál — celá zakázka
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MaterialGantt projectId={id} items={materials} />
          </CardContent>
        </Card>
      )}

      {tab === "members" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Členové zakázky</CardTitle>
          </CardHeader>
          <CardContent>
            <MembersPanel
              projectId={id}
              members={members.map((m) => ({
                userId: m.userId,
                displayName: m.displayName,
                nickname: m.nickname,
                projectRole: m.projectRole,
                addedAt: m.addedAt,
              }))}
              addableUsers={addableUsers.map((u) => ({
                id: u.id,
                displayName: u.displayName,
                nickname: u.nickname,
                role: u.role,
              }))}
              canManage={canManage && !archived}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
