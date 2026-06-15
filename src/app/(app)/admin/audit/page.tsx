import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { assertCan, requireUser } from "@/server/rbac";
import { listAuditActions, listAuditEntries } from "@/server/services/audit";

import { VerifyChainButton } from "./VerifyChainButton";
import { AuditRowDetails } from "./AuditRowDetails";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function pickString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  const user = await requireUser();
  assertCan(user, "audit.read");

  const params = await searchParams;
  const action = pickString(params.action);
  const entityType = pickString(params.entityType);
  const entityId = pickString(params.entityId);
  const actorId = pickString(params.actorId);

  const [{ rows, nextCursor }, allActions] = await Promise.all([
    listAuditEntries({ action, entityType, entityId, actorId, limit: 100 }),
    listAuditActions(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle>Audit log</CardTitle>
            <CardDescription>
              Tamper-evidentní záznam všech mutací. Každý řádek nese hash
              předchozího, takže jakákoli změna v minulosti naruší řetěz.
            </CardDescription>
          </div>
          <VerifyChainButton />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filtr</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="get"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="action">Akce</Label>
              <select
                id="action"
                name="action"
                defaultValue={action ?? ""}
                className="h-9 rounded-md border bg-background px-3 text-sm shadow-xs"
              >
                <option value="">— všechny —</option>
                {allActions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="entityType">Typ entity</Label>
              <Input
                id="entityType"
                name="entityType"
                defaultValue={entityType ?? ""}
                placeholder="user / project / report …"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="entityId">ID entity</Label>
              <Input id="entityId" name="entityId" defaultValue={entityId ?? ""} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="actorId">ID aktéra</Label>
              <Input id="actorId" name="actorId" defaultValue={actorId ?? ""} />
            </div>
            <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
              <a
                href="/admin/audit"
                className="text-sm text-muted-foreground hover:underline"
              >
                Vymazat filtr
              </a>
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Filtrovat
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Čas</TableHead>
              <TableHead>Aktér</TableHead>
              <TableHead>Akce</TableHead>
              <TableHead>Entita</TableHead>
              <TableHead className="hidden md:table-cell">IP</TableHead>
              <TableHead className="text-right">Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  Žádné záznamy odpovídající filtru.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.id}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {formatDateTime(r.ts)}
                </TableCell>
                <TableCell className="text-sm">
                  {r.actorNickname ? (
                    <span className="font-mono">{r.actorNickname}</span>
                  ) : (
                    <span className="text-muted-foreground">system</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-mono text-[11px]">
                    {r.action}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.entityType}/{r.entityId}
                </TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                  {r.ip ?? "—"}
                </TableCell>
                <TableCell className="text-right">
                  <AuditRowDetails row={r} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {nextCursor && (
        <div className="text-center text-sm text-muted-foreground">
          Pro starší záznamy upřesněte filtr — stránkování bude doplněno v
          dalším milníku.
        </div>
      )}
    </div>
  );
}
