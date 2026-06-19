import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { formatDateTime, pragueDayStart } from "@/lib/dates";
import { assertCan, requireUser } from "@/server/rbac";
import {
  listAuditActions,
  listAuditActors,
  listAuditEntityTypes,
  listAuditEntries,
} from "@/server/services/audit";

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Read a YYYY-MM-DD search param as a Prague-midnight Date. */
function pickDate(value: string | string[] | undefined): Date | undefined {
  const s = pickString(value);
  if (!s || !DATE_RE.test(s)) return undefined;
  return pragueDayStart(s);
}

/** Cursor is a bigint serialized via JSON.stringify(.toString()). */
function pickCursor(value: string | string[] | undefined): bigint | undefined {
  const s = pickString(value);
  if (!s) return undefined;
  try {
    return BigInt(s);
  } catch {
    return undefined;
  }
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  const user = await requireUser();
  assertCan(user, "audit.read");

  const params = await searchParams;
  const action = pickString(params.action);
  const entityType = pickString(params.entityType);
  const entityId = pickString(params.entityId);
  const actorId = pickString(params.actorId);
  const from = pickDate(params.from);
  const toRaw = pickDate(params.to);
  // Inclusive `to`: callers pick a calendar day; bump to end-of-day so
  // a single-day range actually returns that day's rows.
  const to = toRaw ? new Date(toRaw.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;
  const cursor = pickCursor(params.cursor);

  const [{ rows, nextCursor }, allActions, allEntityTypes, allActors] =
    await Promise.all([
      listAuditEntries({
        action,
        entityType,
        entityId,
        actorId,
        from,
        to,
        cursor,
        limit: 100,
      }),
      listAuditActions(),
      listAuditEntityTypes(),
      listAuditActors(),
    ]);

  const fromValue = pickString(params.from) ?? "";
  const toValue = pickString(params.to) ?? "";
  const hasFilter = Boolean(
    action || entityType || entityId || actorId || from || to,
  );

  // Forward-only pagination: keep current filters but bump the cursor.
  const nextHref = nextCursor
    ? (() => {
        const q = new URLSearchParams();
        if (action) q.set("action", action);
        if (entityType) q.set("entityType", entityType);
        if (entityId) q.set("entityId", entityId);
        if (actorId) q.set("actorId", actorId);
        if (fromValue) q.set("from", fromValue);
        if (toValue) q.set("to", toValue);
        q.set("cursor", nextCursor);
        return `/admin/audit?${q.toString()}`;
      })()
    : null;

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
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
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
              <select
                id="entityType"
                name="entityType"
                defaultValue={entityType ?? ""}
                className="h-9 rounded-md border bg-background px-3 text-sm shadow-xs"
              >
                <option value="">— všechny —</option>
                {allEntityTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="actorId">Aktér</Label>
              <select
                id="actorId"
                name="actorId"
                defaultValue={actorId ?? ""}
                className="h-9 rounded-md border bg-background px-3 text-sm shadow-xs"
              >
                <option value="">— všichni —</option>
                {allActors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName} ({a.nickname})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="entityId">ID entity</Label>
              <Input
                id="entityId"
                name="entityId"
                defaultValue={entityId ?? ""}
                placeholder="přesný ID, např. cuid"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="from">Od (datum)</Label>
              <Input id="from" name="from" type="date" defaultValue={fromValue} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="to">Do (datum)</Label>
              <Input id="to" name="to" type="date" defaultValue={toValue} />
            </div>
            <div className="sm:col-span-2 lg:col-span-3 flex items-center justify-end gap-2">
              {hasFilter && (
                <Link
                  href="/admin/audit"
                  className="text-sm text-muted-foreground hover:underline"
                >
                  Vymazat filtr
                </Link>
              )}
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

      {nextHref && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" render={<Link href={nextHref} />}>
            Načíst starších 100
          </Button>
        </div>
      )}
    </div>
  );
}
