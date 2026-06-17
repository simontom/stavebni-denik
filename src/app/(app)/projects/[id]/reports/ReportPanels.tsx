"use client";

import { useRef, useTransition } from "react";
import { Check, Loader2, Plus, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";

import {
  addMaterialAction,
  addRemarkAction,
  setManualWeatherAction,
  toggleMaterialAction,
} from "./actions";

interface ReportRef {
  reportId: string;
  projectId: string;
  date: string;
}

/** Hidden inputs identifying the report + revalidation target. */
function HiddenRefs({ reportId, projectId, date }: ReportRef) {
  return (
    <>
      <input type="hidden" name="reportId" value={reportId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="date" value={date} />
    </>
  );
}

/** Add-a-remark form (members incl. GUEST/TDS). */
export function RemarkForm(props: ReportRef) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  function handle(fd: FormData) {
    startTransition(async () => {
      await addRemarkAction(fd);
      ref.current?.reset();
    });
  }

  return (
    <form ref={ref} action={handle} className="grid gap-2">
      <HiddenRefs {...props} />
      <Label htmlFor="remark-text" className="sr-only">
        Připomínka
      </Label>
      <Textarea
        id="remark-text"
        name="text"
        rows={2}
        required
        placeholder="Napište připomínku k tomuto dni…"
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Přidat připomínku
        </Button>
      </div>
    </form>
  );
}

export interface MaterialItem {
  id: string;
  text: string;
  neededBy: string | null;
  resolved: boolean;
}

interface MaterialsPanelProps extends ReportRef {
  items: MaterialItem[];
  canAdd: boolean;
  canResolve: boolean;
}

/** Material checklist: list with resolve toggle + add form. */
export function MaterialsPanel({
  items,
  canAdd,
  canResolve,
  ...refs
}: MaterialsPanelProps) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  function handleAdd(fd: FormData) {
    startTransition(async () => {
      await addMaterialAction(fd);
      ref.current?.reset();
    });
  }

  function toggle(id: string, resolved: boolean) {
    const fd = new FormData();
    fd.append("materialId", id);
    fd.append("resolved", String(resolved));
    fd.append("projectId", refs.projectId);
    fd.append("date", refs.date);
    startTransition(async () => {
      await toggleMaterialAction(fd);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Zatím žádné požadavky na materiál.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {items.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="flex flex-col">
                <span
                  className={
                    m.resolved
                      ? "text-sm text-muted-foreground line-through"
                      : "text-sm"
                  }
                >
                  {m.text}
                </span>
                {m.neededBy && (
                  <span className="text-xs text-muted-foreground">
                    Potřeba do: {formatDate(m.neededBy)}
                  </span>
                )}
              </div>
              {canResolve && (
                <Button
                  type="button"
                  variant={m.resolved ? "ghost" : "outline"}
                  size="sm"
                  disabled={pending}
                  onClick={() => toggle(m.id, !m.resolved)}
                >
                  {m.resolved ? (
                    <>
                      <RotateCcw className="size-4" aria-hidden /> Obnovit
                    </>
                  ) : (
                    <>
                      <Check className="size-4" aria-hidden /> Vyřízeno
                    </>
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
        <form ref={ref} action={handleAdd} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <HiddenRefs {...refs} />
          <div className="grid gap-1.5">
            <Label htmlFor="material-text" className="sr-only">
              Materiál
            </Label>
            <Input
              id="material-text"
              name="text"
              required
              placeholder="napr. beton C20/25 – 3 m³"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="material-needed" className="text-xs text-muted-foreground">
              Potřeba do
            </Label>
            <Input id="material-needed" name="neededBy" type="date" />
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
            Přidat
          </Button>
        </form>
      )}
    </div>
  );
}

interface ManualWeatherFormProps extends ReportRef {
  defaultSummary: string;
}

/** Manual weather entry shown only when the auto fetch was unavailable. */
export function ManualWeatherForm({
  defaultSummary,
  ...refs
}: ManualWeatherFormProps) {
  const [pending, startTransition] = useTransition();

  function handle(fd: FormData) {
    startTransition(async () => {
      await setManualWeatherAction(fd);
    });
  }

  return (
    <form action={handle} className="grid gap-3">
      <HiddenRefs {...refs} />
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="tempMinC">Teplota min (°C)</Label>
          <Input id="tempMinC" name="tempMinC" inputMode="decimal" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="tempMaxC">Teplota max (°C)</Label>
          <Input id="tempMaxC" name="tempMaxC" inputMode="decimal" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="precipitationMm">Srážky (mm)</Label>
          <Input id="precipitationMm" name="precipitationMm" inputMode="decimal" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="windMaxKmh">Vítr max (km/h)</Label>
          <Input id="windMaxKmh" name="windMaxKmh" inputMode="decimal" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="summary">Slovní popis</Label>
        <Input
          id="summary"
          name="summary"
          defaultValue={defaultSummary}
          placeholder="napr. Polojasno, mírný vítr"
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Uložit počasí ručně
        </Button>
      </div>
    </form>
  );
}
