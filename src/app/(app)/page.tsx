import Link from "next/link";
import {
  AlertCircle,
  Archive,
  Briefcase,
  CalendarDays,
  ClipboardList,
  GanttChart,
  Lock,
  Package,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate, formatDateInput } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import { getBossDashboard } from "@/server/services/dashboard";

import { ProjectsGantt } from "./ProjectsGantt";

export const dynamic = "force-dynamic";

/**
 * Authenticated landing.
 *
 * For BOSS we render a real cross-project dashboard (active projects,
 * unsigned reports, pending materials, recent activity). For WORKER /
 * GUEST we keep a minimalist navigation hub — they only see their own
 * projects anyway, so a firm-wide aggregate would be misleading.
 */

interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  href?: string;
  emphasise?: boolean;
}

function StatCard({ label, value, hint, Icon, href, emphasise }: StatCardProps) {
  const card = (
    <Card
      className={
        emphasise && typeof value === "number" && value > 0
          ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
          : undefined
      }
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="size-4" aria-hidden /> {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block transition hover:opacity-90">
      {card}
    </Link>
  ) : (
    card
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const isBoss = user.role === "BOSS";

  if (!isBoss) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header>
          <h1 className="text-2xl font-semibold">
            Vítejte, {user.displayName}
          </h1>
          <p className="text-muted-foreground">
            Elektronický stavební deník dle § 157 stavebního zákona.
          </p>
        </header>

        <section className="grid gap-4 sm:grid-cols-2">
          <Link href="/projects" className="group">
            <Card className="h-full transition-colors group-hover:border-primary">
              <CardHeader>
                <CardTitle>Zakázky</CardTitle>
                <CardDescription>
                  Přehled staveb, k nimž máte přístup, a denní záznamy.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Otevřít →
              </CardContent>
            </Card>
          </Link>
        </section>
      </div>
    );
  }

  const data = await getBossDashboard(user);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">
          Vítejte, {user.displayName}
        </h1>
        <p className="text-muted-foreground">
          Souhrn napříč všemi zakázkami za posledních 7 dní.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Aktivní zakázky"
          value={data.activeProjects}
          hint={
            data.archivedProjects > 0
              ? `+ ${data.archivedProjects} archivovaných`
              : undefined
          }
          Icon={Briefcase}
          href="/projects"
        />
        <StatCard
          label="Nepodepsané záznamy"
          value={data.unsignedReportsTotal}
          hint="Vyžadují podpis stavbyvedoucího."
          Icon={Lock}
          emphasise
        />
        <StatCard
          label="Záznamy za 7 dní"
          value={data.reportsLast7Days}
          hint="Aktivita stavby."
          Icon={CalendarDays}
        />
        <StatCard
          label="Otevřené požadavky na materiál"
          value={data.pendingMaterialsTotal}
          hint="Nevyřízené checklist položky."
          Icon={Package}
          emphasise
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="size-4" aria-hidden /> Zakázky s nepodepsanými záznamy
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.unsignedByProject.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Vše podepsané. 👍
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {data.unsignedByProject.map((p) => (
                  <li key={p.projectId} className="py-2">
                    <Link
                      href={`/projects/${p.projectId}?tab=reports&status=unsigned`}
                      className="flex items-center justify-between hover:underline"
                    >
                      <span className="text-sm font-medium">
                        {p.projectName}
                      </span>
                      <Badge variant="secondary">
                        {p.unsignedCount} nepodepsaných
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="size-4" aria-hidden /> Nevyřízený materiál
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.pendingMaterials.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Žádné otevřené požadavky.
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {data.pendingMaterials.map((m) => {
                  const reportDateStr = formatDateInput(m.reportDate);
                  return (
                    <li key={m.id} className="py-2">
                      <Link
                        href={`/projects/${m.projectId}/reports/${reportDateStr}`}
                        className="grid gap-0.5 hover:underline"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium">{m.text}</span>
                          {m.neededBy && (
                            <Badge variant="outline">
                              do {formatDate(m.neededBy)}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.projectName} · {formatDate(m.reportDate)} ·{" "}
                          {m.authorName}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GanttChart className="size-4" aria-hidden /> Časový přehled zakázek
          </CardTitle>
          <CardDescription>
            Zahájení až dokončení (nebo „probíhá“). Šířka osy se přizpůsobí
            nejdelší zakázce.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProjectsGantt items={data.timelineProjects} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4" aria-hidden /> Poslední záznamy
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentReports.length === 0 ? (
            <p className="text-sm text-muted-foreground">Žádné záznamy.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {data.recentReports.map((r) => {
                const dateStr = formatDateInput(r.date);
                return (
                  <li key={r.id} className="py-2">
                    <Link
                      href={`/projects/${r.projectId}/reports/${dateStr}`}
                      className="grid gap-0.5 hover:underline sm:grid-cols-[1fr_auto] sm:items-center"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {formatDate(r.date)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {r.projectName}
                        </span>
                        {r.signed ? (
                          <Badge variant="secondary">
                            <Lock className="size-3" aria-hidden /> Podepsáno
                          </Badge>
                        ) : (
                          <Badge variant="outline">
                            <AlertCircle className="size-3" aria-hidden /> Nepodepsané
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {r.authorName}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-3 sm:grid-cols-3">
        <Link href="/projects" className="group">
          <Card className="h-full transition-colors group-hover:border-primary">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Briefcase className="size-4" aria-hidden /> Zakázky
              </CardTitle>
              <CardDescription>Seznam staveb, archiv.</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/admin/users" className="group">
          <Card className="h-full transition-colors group-hover:border-primary">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="size-4" aria-hidden /> Uživatelé
              </CardTitle>
              <CardDescription>
                {data.membersTotal} členství v zakázkách.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/admin/audit" className="group">
          <Card className="h-full transition-colors group-hover:border-primary">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Archive className="size-4" aria-hidden /> Audit log
              </CardTitle>
              <CardDescription>
                Záznamy všech změn a ověření integrity řetězu.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </section>
    </div>
  );
}
