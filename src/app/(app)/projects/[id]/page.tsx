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
  Pencil,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatDateInput } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import {
  getProjectForUser,
  listAddableUsers,
} from "@/server/services/projects";
import {
  canCreateReport,
  listReportsForProject,
} from "@/server/services/reports";

import { MembersPanel } from "./MembersPanel";
import { NewReportDayPicker } from "./NewReportDayPicker";
import { PdfExportForm } from "./PdfExportForm";
import { ProjectStatusButton } from "./ProjectStatusButton";

type ProjectTab = "details" | "reports" | "members";

function resolveTab(value: string | string[] | undefined): ProjectTab {
  if (value === "reports") return "reports";
  if (value === "members") return "members";
  return "details";
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
  const detail = await getProjectForUser(id, user);
  if (!detail) notFound();

  const { project, members, canManage } = detail;
  const sp = await searchParams;
  const tab = resolveTab(sp.tab);
  const archived = project.deletedAt !== null;

  const addableUsers = canManage && !archived ? await listAddableUsers(id) : [];
  const reports = tab === "reports" ? await listReportsForProject(id, user) : [];
  const canCreate =
    tab === "reports" && !archived ? await canCreateReport(id, user) : false;
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
                Denní záznamy ({reports.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {reports.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Zatím žádný denní záznam.
                </p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {reports.map((r) => {
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
