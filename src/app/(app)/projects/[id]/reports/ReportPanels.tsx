"use client";

import { useRef, useState, useTransition } from "react";
import { Check, CheckCheck, Loader2, Plus, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";

import {
  addMaterialAction,
  addRemarkAction,
  bulkResolveMaterialsAction,
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

interface RemarkFormProps extends ReportRef {
  /** True when the current user role may sign an "official" record. */
  showOfficialOption: boolean;
}

/** Add-a-remark form (members incl. GUEST/TDS). */
export function RemarkForm({ showOfficialOption, ...refs }: RemarkFormProps) {
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
      <HiddenRefs {...refs} />
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
      <div className="flex items-center justify-between gap-3">
        {showOfficialOption ? (
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              name="isOfficial"
              value="true"
              className="size-4 cursor-pointer rounded border-input"
            />
            Označit jako oficiální záznam (TDS / BOZP / projektant)
          </label>
        ) : (
          <span />
        )}
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

/** Material checklist: list with resolve toggle + bulk resolve + add form. */
export function MaterialsPanel({
  items,
  canAdd,
  canResolve,
  ...refs
}: MaterialsPanelProps) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllUnresolved() {
    setSelected(new Set(items.filter((m) => !m.resolved).map((m) => m.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function bulkResolve() {
    if (selected.size === 0) return;
    const fd = new FormData();
    fd.append("projectId", refs.projectId);
    fd.append("date", refs.date);
    for (const id of selected) fd.append("materialId", id);
    startTransition(async () => {
      await bulkResolveMaterialsAction(fd);
      clearSelection();
    });
  }

  const unresolvedCount = items.filter((m) => !m.resolved).length;
  const allUnresolvedSelected =
    unresolvedCount > 0 &&
    items.filter((m) => !m.resolved).every((m) => selected.has(m.id));

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Zatím žádné požadavky na materiál.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {items.map((m) => {
            const checked = selected.has(m.id);
            const isSelectable = canResolve && !m.resolved;
            return (
              <li
                key={m.id}
                className="flex items-center gap-3 py-2"
              >
                {isSelectable ? (
                  <input
                    type="checkbox"
                    aria-label={`Vybrat ${m.text}`}
                    checked={checked}
                    onChange={() => toggleSelected(m.id)}
                    disabled={pending}
                    className="size-4 cursor-pointer rounded border-input"
                  />
                ) : (
                  <span className="size-4" aria-hidden />
                )}
                <div className="flex flex-1 flex-col">
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
            );
          })}
        </ul>
      )}

      {canResolve && unresolvedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={
                allUnresolvedSelected ? clearSelection : selectAllUnresolved
              }
              disabled={pending}
            >
              {allUnresolvedSelected
                ? "Zrušit výběr"
                : `Vybrat všechny (${unresolvedCount})`}
            </Button>
            <span className="text-muted-foreground">
              {selected.size > 0
                ? `${selected.size} vybráno`
                : "Vyberte položky pro hromadné vyřízení."}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={bulkResolve}
            disabled={pending || selected.size === 0}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <CheckCheck className="size-4" aria-hidden />
            )}
            Vyřídit vybrané
          </Button>
        </div>
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
