import type { Metadata } from "next";
import Link from "next/link";
import { Archive, FolderOpen, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { requireUser } from "@/server/rbac";
import {
  listArchivedProjects,
  listProjectsForUser,
  type ProjectListItem,
} from "@/server/services/projects";

export const metadata: Metadata = { title: "Zakázky" };
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProjectsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const isBoss = user.role === "BOSS";

  const params = await searchParams;
  const showArchived = isBoss && params.archived === "1";

  const projects: ProjectListItem[] = showArchived
    ? await listArchivedProjects()
    : await listProjectsForUser(user);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle>{showArchived ? "Archiv zakázek" : "Zakázky"}</CardTitle>
            <CardDescription>
              {showArchived
                ? "Archivované (uzavřené) stavby. Deník zůstává zachován pro pozdější kontrolu."
                : isBoss
                  ? "Přehled všech staveb firmy. Založte novou zakázku a přiřaďte k ní pracovníky a dozor."
                  : "Stavby, ke kterým máte přístup."}
            </CardDescription>
          </div>
          {isBoss && (
            <div className="flex items-center gap-2">
              {showArchived ? (
                <Button variant="outline" size="sm" render={<Link href="/projects" />}>
                  <FolderOpen className="size-4" aria-hidden /> Aktivní
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link href="/projects?archived=1" />}
                >
                  <Archive className="size-4" aria-hidden /> Archiv
                </Button>
              )}
              <Button size="sm" render={<Link href="/projects/new" />}>
                <Plus className="size-4" aria-hidden /> Nová zakázka
              </Button>
            </div>
          )}
        </CardHeader>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Název</TableHead>
              <TableHead className="hidden sm:table-cell">Místo</TableHead>
              <TableHead className="hidden md:table-cell">Stavbyvedoucí</TableHead>
              <TableHead className="hidden lg:table-cell">Členů</TableHead>
              <TableHead>{showArchived ? "Archivováno" : "Zahájeno"}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {showArchived
                    ? "Archiv je prázdný."
                    : isBoss
                      ? "Zatím žádné zakázky. Založte první stavbu."
                      : "Nemáte přístup k žádné zakázce. Požádejte stavbyvedoucího o přiřazení."}
                </TableCell>
              </TableRow>
            )}
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link
                    href={`/projects/${p.id}`}
                    className="font-medium hover:text-primary hover:underline"
                  >
                    {p.name}
                  </Link>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                  {p.address}
                </TableCell>
                <TableCell className="hidden md:table-cell text-sm">
                  {p.siteManagerName}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <Badge variant="secondary">{p.memberCount}</Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {showArchived
                    ? p.deletedAt
                      ? formatDate(p.deletedAt)
                      : "—"
                    : p.startedAt
                      ? formatDate(p.startedAt)
                      : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
