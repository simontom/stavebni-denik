"use client";

import { useRef } from "react";
import { CalendarClock, Trash2, UserCheck } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/dates";
import { VISITOR_ROLES } from "@/lib/visits-types";

import { addVisitAction, deleteVisitAction } from "./actions";

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
 */
export function VisitsPanel({ projectId, dateStr, reportId, items, disabled }: Props) {
  const formRef = useRef<HTMLFormElement>(null);

  const {
    execute: executeAddVisit,
    isPending: isAddingVisit,
    result,
  } = useAction(addVisitAction, {
    onSuccess: () => {
      formRef.current?.reset();
      toast.success("Návštěva zaznamenána");
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? "Uložení návštěvy se nezdařilo.");
    },
  });

  const { execute: executeDeleteVisit, isPending: isDeletingVisit } = useAction(deleteVisitAction, {
    onSuccess: () => {
      toast.success("Návštěva byla odstraněna.");
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? "Smazání návštěvy se nezdařilo.");
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const visitorName = String(fd.get("visitorName") ?? "").trim();
    const visitorRole = String(fd.get("visitorRole") ?? "") as (typeof VISITOR_ROLES)[number];
    const organization = String(fd.get("organization") ?? "").trim() || undefined;
    const visitedAt = String(fd.get("visitedAt") ?? "").trim() || undefined;
    const purpose = String(fd.get("purpose") ?? "").trim();
    const notes = String(fd.get("notes") ?? "").trim() || undefined;

    executeAddVisit({
      reportId,
      projectId,
      date: dateStr,
      visitorName,
      visitorRole,
      organization,
      visitedAt,
      purpose,
      notes,
    });
  }

  function handleDelete(id: string) {
    const ok = window.confirm("Opravdu smazat tuto návštěvu?");
    if (!ok) return;
    executeDeleteVisit({ id, projectId, date: dateStr });
  }

  const fieldErrors = result.validationErrors;

  return (
    <div className="grid gap-4">
      {/* Seznam existujících návštěv */}
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
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
                    <span className="text-muted-foreground text-xs">{v.organization}</span>
                  )}
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {formatDateTime(v.visitedAt)}
                </div>
              </div>
              <p className="text-sm whitespace-pre-wrap">{v.purpose}</p>
              {v.notes && (
                <p className="text-muted-foreground text-sm whitespace-pre-wrap">{v.notes}</p>
              )}
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-muted-foreground text-xs">Zapsal {v.authorName}</span>
                {!disabled && v.canDelete && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Smazat návštěvu"
                    disabled={isDeletingVisit}
                    onClick={() => handleDelete(v.id)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
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
          onSubmit={handleSubmit}
          className="bg-muted/30 grid gap-3 rounded-md border p-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="visitorName">Jméno návštěvníka *</Label>
              <Input
                id="visitorName"
                name="visitorName"
                required
                maxLength={200}
                aria-invalid={!!fieldErrors?.visitorName?._errors?.[0]}
              />
              {fieldErrors?.visitorName?._errors?.[0] && (
                <p className="text-destructive text-xs">{fieldErrors.visitorName._errors[0]}</p>
              )}
            </div>

            <div className="grid gap-1">
              <Label htmlFor="visitorRole">Role *</Label>
              <select
                id="visitorRole"
                name="visitorRole"
                required
                defaultValue="TDS"
                className="border-input bg-background focus:ring-ring flex h-10 w-full rounded-md border px-3 text-sm shadow-xs focus:ring-2 focus:outline-none"
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
                aria-invalid={!!fieldErrors?.visitedAt?._errors?.[0]}
              />
              {fieldErrors?.visitedAt?._errors?.[0] && (
                <p className="text-destructive text-xs">{fieldErrors.visitedAt._errors[0]}</p>
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
              aria-invalid={!!fieldErrors?.purpose?._errors?.[0]}
            />
            {fieldErrors?.purpose?._errors?.[0] && (
              <p className="text-destructive text-xs">{fieldErrors.purpose._errors[0]}</p>
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

          {result.serverError && <p className="text-destructive text-sm">{result.serverError}</p>}

          <div className="flex items-center justify-end">
            <Button type="submit" disabled={isAddingVisit}>
              <UserCheck className="size-4" aria-hidden />
              {isAddingVisit ? "Ukládám..." : "Přidat návštěvu"}
            </Button>
          </div>
        </form>
      )}

      {disabled && items.length === 0 && (
        <p className="text-muted-foreground text-xs">
          Záznam je podepsaný — další návštěvy lze přidat jen jako dodatek.
        </p>
      )}
    </div>
  );
}
