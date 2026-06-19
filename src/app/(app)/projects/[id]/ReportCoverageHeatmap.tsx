import Link from "next/link";

import { formatDate, formatDateInput } from "@/lib/dates";
import type {
  ReportCoverage,
  ReportCoverageDay,
  ReportCoverageState,
} from "@/server/services/reports";

interface Props {
  projectId: string;
  coverage: ReportCoverage;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const STATE_LABEL: Record<ReportCoverageState, string> = {
  missing: "Bez záznamu",
  draft: "Záznam (nepodepsaný)",
  signed: "Podepsáno",
};

const STATE_CLASS: Record<ReportCoverageState, string> = {
  missing: "bg-muted",
  draft: "bg-amber-300 dark:bg-amber-600/70",
  signed: "bg-emerald-500 dark:bg-emerald-600",
};

/** Czech weekday label for the left-hand grid axis. */
const WEEKDAY_LABELS = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

/** Returns 0..6 with Monday = 0 (Czech calendar starts on Monday). */
function mondayBasedDow(d: Date): number {
  // d is a midnight UTC for the Prague day; getUTCDay() returns 0 = Sunday.
  const sun = d.getUTCDay();
  return (sun + 6) % 7;
}

interface Week {
  /** Days of this week. May contain `null` for padding at the very start. */
  days: Array<ReportCoverageDay | null>;
  /** Date of the first non-null day in the week — for month-label placement. */
  firstDate: Date;
}

/** Group flat day list into Monday-aligned weeks (with a leading pad). */
function groupIntoWeeks(days: ReportCoverageDay[]): Week[] {
  if (days.length === 0) return [];
  const weeks: Week[] = [];
  const firstDow = mondayBasedDow(days[0]!.date);

  let current: Week = {
    days: Array.from({ length: firstDow }, () => null),
    firstDate: days[0]!.date,
  };
  for (const day of days) {
    current.days.push(day);
    if (current.days.length === 7) {
      weeks.push(current);
      current = { days: [], firstDate: day.date };
    }
  }
  if (current.days.length > 0) {
    while (current.days.length < 7) current.days.push(null);
    weeks.push(current);
  }
  return weeks;
}

/**
 * Server-rendered per-project coverage heatmap.
 *
 * One column per week, one row per weekday (Monday-aligned). Each cell
 * carries a colour:
 *   * grey   — no daily report,
 *   * amber  — report exists but unsigned (draft),
 *   * green  — report is signed and locked.
 *
 * A click on any cell navigates to `/projects/{id}/reports/{date}`,
 * which renders the day (or the create form if it doesn't exist yet).
 * No client JS — just `<Link>` cells with `title` tooltips.
 */
export function ReportCoverageHeatmap({ projectId, coverage }: Props) {
  if (coverage.days.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Žádné dny v rozsahu zakázky.
      </p>
    );
  }

  const weeks = groupIntoWeeks(coverage.days);
  const pct = (n: number) =>
    Math.round((n / coverage.days.length) * 100);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Období {formatDate(coverage.from)} – {formatDate(coverage.to)}
        </span>
        <span>{coverage.days.length} dní</span>
        <span>
          podepsaných: {coverage.totals.signed} ({pct(coverage.totals.signed)} %)
        </span>
        <span>
          nepodepsaných: {coverage.totals.draft} ({pct(coverage.totals.draft)} %)
        </span>
        <span>
          chybí: {coverage.totals.missing} ({pct(coverage.totals.missing)} %)
        </span>
      </div>

      <div className="overflow-x-auto">
        <div className="flex gap-1.5">
          {/* Weekday axis */}
          <div
            className="grid grid-rows-7 gap-[3px] pr-1 text-[10px] text-muted-foreground"
            aria-hidden
          >
            {WEEKDAY_LABELS.map((l, i) => (
              <span
                key={i}
                className="flex h-3 items-center leading-none"
              >
                {/* Show every other label so the column stays tight. */}
                {i % 2 === 0 ? l : ""}
              </span>
            ))}
          </div>

          {/* Week columns */}
          <div className="flex gap-[3px]">
            {weeks.map((week, wi) => (
              <div
                key={wi}
                className="grid grid-rows-7 gap-[3px]"
              >
                {week.days.map((day, di) => {
                  if (!day) {
                    return (
                      <span
                        key={di}
                        className="size-3 rounded-sm bg-transparent"
                        aria-hidden
                      />
                    );
                  }
                  const dateStr = formatDateInput(day.date);
                  const tooltip = `${formatDate(day.date)} — ${
                    STATE_LABEL[day.state]
                  }`;
                  return (
                    <Link
                      key={di}
                      href={`/projects/${projectId}/reports/${dateStr}`}
                      title={tooltip}
                      aria-label={tooltip}
                      className={
                        "block size-3 rounded-sm transition hover:ring-2 hover:ring-primary " +
                        STATE_CLASS[day.state]
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span
            className={"size-3 rounded-sm " + STATE_CLASS.missing}
            aria-hidden
          />
          bez záznamu
        </span>
        <span className="flex items-center gap-1">
          <span
            className={"size-3 rounded-sm " + STATE_CLASS.draft}
            aria-hidden
          />
          nepodepsaný
        </span>
        <span className="flex items-center gap-1">
          <span
            className={"size-3 rounded-sm " + STATE_CLASS.signed}
            aria-hidden
          />
          podepsáno
        </span>
      </div>
    </div>
  );
}

// Re-export for callers that want to forward the helper without
// duplicating the DAY_MS constant.
export { DAY_MS };
