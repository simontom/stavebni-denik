"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { AuditRow } from "@/server/services/audit";

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/**
 * Per-row "Detail" dialog for the audit log: shows the before/after
 * snapshots (diffable JSON) together with the chain hashes and request
 * metadata, so a BOSS can inspect exactly what changed.
 */
export function AuditRowDetails({ row }: { row: AuditRow }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        Detail
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audit záznam #{row.id}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{row.action}</span> ·{" "}
            <span className="font-mono">
              {row.entityType}/{row.entityId}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[70vh] flex-col gap-4 overflow-auto">
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">Před</h3>
            <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
              {pretty(row.before)}
            </pre>
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">Po</h3>
            <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
              {pretty(row.after)}
            </pre>
          </section>

          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Aktér</dt>
            <dd className="font-mono break-all">
              {row.actorNickname ?? row.actorId ?? "system"}
            </dd>
            <dt className="text-muted-foreground">IP</dt>
            <dd className="font-mono break-all">{row.ip ?? "—"}</dd>
            <dt className="text-muted-foreground">User agent</dt>
            <dd className="break-all">{row.userAgent ?? "—"}</dd>
            <dt className="text-muted-foreground">prev_hash</dt>
            <dd className="font-mono break-all">{row.prevHash}</dd>
            <dt className="text-muted-foreground">row_hash</dt>
            <dd className="font-mono break-all">{row.rowHash}</dd>
          </dl>
        </div>
      </DialogContent>
    </Dialog>
  );
}
