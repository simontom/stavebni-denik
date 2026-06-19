import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDate, formatDateInput } from "@/lib/dates";
import type {
  ReportCoverage,
  ReportCoverageState,
} from "@/server/services/reports";

interface Props {
  projectId: string;
  /** Anchor day for the displayed month (any day inside it). */
  monthAnchor: Date;
  /** Coverage for *exactly* the month being rendered (no padding days). */
  coverage: ReportCoverage;
  /** Prev / next month nav targets (YYYY-MM). */
  prevMonth: string;
  nextMonth: string;
}

const STATE_CLASS: Record<ReportCoverageState, string> = {
  missing: "bg-muted/40",
  draft: "bg-amber-100 dark:bg-amber-900/40",
  signed: "bg-emerald-100 dark:bg-emerald-900/40",
};
const STATE_DOT: Record<ReportCoverageState, string> = {
  missing: "bg-transparent",
  draft: "bg-amber-500",
  signed: "bg-emerald-500",
};
const STATE_LABEL: Record<ReportCoverageState, string> = {
  missing: "bez záznamu",
  draft: "nepodepsaný",
  signed: "podepsáno",
};

const WEEKDAY_LABELS = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

/** Monday-based day-of-week index 0..6. */
function mondayBasedDow(d: Date): number {
  const sun = d.getUTCDay();
  return (sun + 6) % 7;
}

const MONTH_NAMES = [
  "leden",
  "únor",
  "březen",
  "duben",
  "květen",
  "červen",
  "červenec",
  "srpen",
  "září",
  "říjen",
  "listopad",
  "prosinec",
];

/**
 * Monthly calendar view of daily reports for a single project.
 *
 * Server-rendered: each cell is a `<Link>` to
 * `/projects/[id]/reports/[date]`. Background colour mirrors the
 * day-coverage heatmap (missing / draft / signed) but cells are full
 * size so the day number and weekday context are readable on phones.
 *
 * Month navigation flips `?month=YYYY-MM` and re-renders the whole
 * project page — no client JS.
 */
export function ReportCalendarMonth({
  projectId,
  monthAnchor,
  coverage,
  prevMonth,
  nextMonth,
}: Props) {
  const year = monthAnchor.getUTCFullYear();
  const monthIdx = monthAnchor.getUTCMonth();
  const monthLabel = `${MONTH_NAMES[monthIdx]} ${year}`;
  const todayIso = formatDateInput(new Date());

  // Build a Map for O(1) lookup by ISO Prague day.
  const byDay = new Map<string, ReportCoverageState>();
  for (const d of coverage.days) {
    byDay.set(formatDateInput(d.date), d.state);
  }

  const firstOfMonth = new Date(Date.UTC(year, monthIdx, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const leadingPad = mondayBasedDow(firstOfMonth);
  const totalCells = Math.ceil((leadingPad + daysInMonth) / 7) * 7;

  // Build cells: leading pad → days → trailing pad to fill the last row.
  const cells: Array<{ date: Date; inMonth: boolean }> = [];
  // Leading pad — previous month days.
  for (let i = leadingPad; i > 0; i--) {
    cells.push({
      date: new Date(Date.UTC(year, monthIdx, 1 - i)),
      inMonth: false,
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(Date.UTC(year, monthIdx, d)), inMonth: true });
  }
  for (let i = 1; cells.length < totalCells; i++) {
    cells.push({
      date: new Date(Date.UTC(year, monthIdx, daysInMonth + i)),
      inMonth: false,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          render={
            <Link
              href={`/projects/${projectId}?tab=reports&month=${prevMonth}`}
              aria-label="Předchozí měsíc"
            />
          }
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <h3 className="text-sm font-medium capitalize">{monthLabel}</h3>
        <Button
          variant="outline"
          size="sm"
          render={
            <Link
              href={`/projects/${projectId}?tab=reports&month=${nextMonth}`}
              aria-label="Následující měsíc"
            />
          }
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
        {WEEKDAY_LABELS.map((l, i) => (
          <span
            key={i}
            className={i >= 5 ? "py-1 font-medium text-foreground/60" : "py-1"}
          >
            {l}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, i) => {
          const iso = formatDateInput(c.date);
          const state: ReportCoverageState | undefined = c.inMonth
            ? byDay.get(iso) ?? "missing"
            : undefined;
          const isToday = iso === todayIso;
          const weekend = mondayBasedDow(c.date) >= 5;

          const baseClass = state
            ? STATE_CLASS[state]
            : "bg-transparent text-muted-foreground/40";

          const cellClass =
            "relative flex aspect-square min-h-12 flex-col items-center justify-start rounded-md border p-1 text-xs transition " +
            baseClass +
            (isToday ? " ring-2 ring-primary" : "") +
            (weekend && c.inMonth ? " font-medium" : "");

          if (!c.inMonth) {
            return (
              <span
                key={i}
                className={cellClass + " opacity-40 pointer-events-none"}
                aria-hidden
              >
                {c.date.getUTCDate()}
              </span>
            );
          }

          const tooltip = `${formatDate(c.date)} — ${STATE_LABEL[state!]}`;
          return (
            <Link
              key={i}
              href={`/projects/${projectId}/reports/${iso}`}
              title={tooltip}
              aria-label={tooltip}
              className={cellClass + " hover:ring-2 hover:ring-primary"}
            >
              <span className="self-end">{c.date.getUTCDate()}</span>
              <span
                className={"mt-auto h-1.5 w-1.5 rounded-full " + STATE_DOT[state!]}
                aria-hidden
              />
            </Link>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-muted/40" aria-hidden />
          bez záznamu
        </span>
        <span className="flex items-center gap-1">
          <span
            className="size-3 rounded-sm bg-amber-100 dark:bg-amber-900/40"
            aria-hidden
          />
          nepodepsaný
        </span>
        <span className="flex items-center gap-1">
          <span
            className="size-3 rounded-sm bg-emerald-100 dark:bg-emerald-900/40"
            aria-hidden
          />
          podepsáno
        </span>
        <span className="flex items-center gap-1">
          <span
            className="size-3 rounded-sm ring-2 ring-primary ring-offset-1"
            aria-hidden
          />
          dnes
        </span>
      </div>
    </div>
  );
}
