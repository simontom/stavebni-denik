"use client";

import { useActionState, useEffect, useRef } from "react";
import { CalendarClock, Trash2, UserCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/dates";
import { VISITOR_ROLES } from "@/server/services/visits";

import {
  addVisitAction,
  deleteVisitAction,
  type VisitFormState,
} from "./actions";

export interface VisitItem {
  id: string;
  visitorName: string;
  visitorRole: string;
  organization: string | null;
  visitedAt: Date;
  purpose: string;
  notes: string | null;
  authorName: string;
  /** Server-computed: BOSS member, nebo author co je member a report není locked. */
  canDelete: boolean;
}

interface Props {
  projectId: string;
  dateStr: string;
  reportId: string;
  /** Existing visits sorted asc by visitedAt. */
  items: VisitItem[];
  /** Disable the form when the report is signed/locked nebo když user není member. */
  disabled: boolean;
}

/**
 * Visits / inspections panel.
 *
 * Render-side:
 *   - List of past visits (chronological).
 *   - Inline form for a new visit (BOSS/WORKER/GUEST who's a member).
 *
 * Justification: vyhláška 499/2006 § 6 vyžaduje záznam návštěv a
 * kontrol (TDS, autorský dozor, investor, BOZP, stavební úřad).
 *
 * Note about useEffect + setState lint rule: handled via toast +
 * formRef.reset() instead of `setOpen` state — no setState in
 * useActionState consumer, so we don't trip the lint rule.
 */
export function VisitsPanel({
  projectId,
  dateStr,
  reportId,
  items,
  disabled,
}: Props) {
  const action = addVisitAction.bind(null, projectId, dateStr);
  const [state, formAction, isPending] = useActionState<
    VisitFormState | undefined,
    FormData
  >(action, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const lastHandledRef = useRef<VisitFormState | undefined>(undefined);

  // Po úspěšném submitu vyresetuj form + toast. Ref je čten v useEffect
  // (po commitu DOM), takže react-hooks/refs neprohraje.
  useEffect(() => {
    if (state && state !== lastHandledRef.current) {
      lastHandledRef.current = state;
      if (state.status === "ok") {
        formRef.current?.reset();
        toast.success("Návštěva zaznamenána");
      }
    }
  }, [state]);

  return (
    <div className="grid gap-4">
      {/* Seznam existujících návštěv */}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Žádné návštěvy ani kontroly nejsou pro tento den zaznamenané.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {items.map((v) => (
            <li key={v.id} className="grid gap-1 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{v.visitorName}</span>
                  <Badge variant="secondary">{v.visitorRole}</Badge>
                  {v.organization && (
                    <span className="text-xs text-muted-foreground">
                      {v.organization}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {formatDateTime(v.visitedAt)}
                </div>
              </div>
              <p className="text-sm whitespace-pre-wrap">{v.purpose}</p>
              {v.notes && (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {v.notes}
                </p>
              )}
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-xs text-muted-foreground">
                  Zapsal {v.authorName}
                </span>
                {!disabled && v.canDelete && (
                  <form action={deleteVisitAction}>
                    <input type="hidden" name="id" value={v.id} />
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="date" value={dateStr} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      aria-label="Smazat návštěvu"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Formulář pro novou návštěvu */}
      {!disabled && (
        <form
          ref={formRef}
          action={formAction}
          className="grid gap-3 rounded-md border bg-muted/30 p-3"
        >
          <input type="hidden" name="reportId" value={reportId} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="visitorName">Jméno návštěvníka *</Label>
              <Input
                id="visitorName"
                name="visitorName"
                required
                maxLength={200}
                aria-invalid={state?.fieldErrors?.visitorName ? true : undefined}
              />
              {state?.fieldErrors?.visitorName && (
                <p className="text-xs text-destructive">
                  {state.fieldErrors.visitorName}
                </p>
              )}
            </div>

            <div className="grid gap-1">
              <Label htmlFor="visitorRole">Role *</Label>
              {/* Native <select> — shadcn Select je overkill pro 8 položek
                  a obchází nám problémy s base-ui na mobilech. */}
              <select
                id="visitorRole"
                name="visitorRole"
                required
                defaultValue="TDS"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {VISITOR_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-1">
              <Label htmlFor="organization">Organizace</Label>
              <Input
                id="organization"
                name="organization"
                maxLength={200}
                placeholder="např. Stavební úřad Praha 7"
              />
            </div>

            <div className="grid gap-1">
              <Label htmlFor="visitedAt">Čas návštěvy *</Label>
              <Input
                id="visitedAt"
                name="visitedAt"
                type="datetime-local"
                required
                aria-invalid={state?.fieldErrors?.visitedAt ? true : undefined}
              />
              {state?.fieldErrors?.visitedAt && (
                <p className="text-xs text-destructive">
                  {state.fieldErrors.visitedAt}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="purpose">Účel návštěvy *</Label>
            <Textarea
              id="purpose"
              name="purpose"
              required
              maxLength={5000}
              rows={2}
              placeholder="např. Kontrola provedení izolace spodní stavby."
              aria-invalid={state?.fieldErrors?.purpose ? true : undefined}
            />
            {state?.fieldErrors?.purpose && (
              <p className="text-xs text-destructive">
                {state.fieldErrors.purpose}
              </p>
            )}
          </div>

          <div className="grid gap-1">
            <Label htmlFor="notes">Poznámka / zjištění / pokyny</Label>
            <Textarea
              id="notes"
              name="notes"
              maxLength={5000}
              rows={3}
              placeholder="Volitelné: detaily, pokyny pro stavbyvedoucího, výsledek kontroly..."
            />
          </div>

          {state?.status === "error" && (
            <p className="text-sm text-destructive">{state.message}</p>
          )}
          {state?.status === "forbidden" && (
            <p className="text-sm text-destructive">
              Nemáte oprávnění zapsat návštěvu.
            </p>
          )}
          {state?.status === "locked" && (
            <p className="text-sm text-destructive">
              Záznam je podepsaný a uzamčený — návštěva musí jít přes dodatek.
            </p>
          )}

          <div className="flex items-center justify-end">
            <Button type="submit" disabled={isPending}>
              <UserCheck className="size-4" aria-hidden />
              {isPending ? "Ukládám..." : "Přidat návštěvu"}
            </Button>
          </div>
        </form>
      )}

      {disabled && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Záznam je podepsaný — další návštěvy lze přidat jen jako dodatek.
        </p>
      )}
    </div>
  );
}
