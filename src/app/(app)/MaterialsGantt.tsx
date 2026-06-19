import Link from "next/link";

import { formatDate } from "@/lib/dates";
import type { MaterialTimelineEntry } from "@/server/services/dashboard";

interface Props {
  items: MaterialTimelineEntry[];
  /** Today / right edge for open items. */
  today?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Tick {
  label: string;
  offsetPct: number;
}

/** Czech locale ticks; density adapts to the timeline span. */
function buildTicks(start: Date, end: Date): Tick[] {
  const totalMs = end.getTime() - start.getTime();
  if (totalMs <= 0) return [];
  const days = totalMs / DAY_MS;

  // For a materials timeline the span tends to be days→months, so the
  // tick step starts at 1 day and steps up via 7d / 30d as needed.
  const stepDays = days <= 14 ? 1 : days <= 90 ? 7 : 30;
  const formatLabel = (d: Date) =>
    d.toLocaleDateString("cs-CZ", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "Europe/Prague",
    });

  const ticks: Tick[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  // Align to a clean grid.
  if (stepDays === 7) {
    // Start on Monday.
    const sun = cursor.getDay();
    const back = (sun + 6) % 7;
    cursor.setDate(cursor.getDate() - back);
  } else if (stepDays === 30) {
    cursor.setDate(1);
  }

  let safety = 16;
  while (cursor.getTime() <= end.getTime() && safety-- > 0) {
    const offsetPct = ((cursor.getTime() - start.getTime()) / totalMs) * 100;
    if (offsetPct >= -1 && offsetPct <= 101) {
      ticks.push({ label: formatLabel(cursor), offsetPct });
    }
    cursor.setDate(cursor.getDate() + stepDays);
  }
  return ticks;
}

interface ProjectGroup {
  projectId: string;
  projectName: string;
  items: MaterialTimelineEntry[];
}

function groupByProject(items: MaterialTimelineEntry[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const m of items) {
    const existing = map.get(m.projectId);
    if (existing) existing.items.push(m);
    else
      map.set(m.projectId, {
        projectId: m.projectId,
        projectName: m.projectName,
        items: [m],
      });
  }
  return Array.from(map.values()).sort((a, b) =>
    a.projectName.localeCompare(b.projectName, "cs"),
  );
}

/** Span (start..end) for one item — `today` covers ongoing items. */
function spanOf(
  m: MaterialTimelineEntry,
  today: Date,
): { start: Date; end: Date } {
  const start = m.createdAt;
  if (m.resolvedAt) return { start, end: m.resolvedAt };
  if (m.neededBy && m.neededBy.getTime() > start.getTime())
    return { start, end: m.neededBy.getTime() > today.getTime() ? m.neededBy : today };
  return { start, end: today };
}

/**
 * Materials Gantt grouped by project. Each row is one material need;
 * the bar runs from `createdAt` to either `resolvedAt` (when done) or
 * `neededBy` (when still open and a deadline exists), padded to today
 * when neither applies.
 *
 * Bars are coloured:
 *   * emerald — resolved on or before the deadline,
 *   * red     — open AND past `neededBy` (overdue),
 *   * primary — open and within deadline (or no deadline).
 *
 * Plain server component; no client JS.
 */
export function MaterialsGantt({ items, today: todayProp }: Props) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Žádné materiálové požadavky s termínem nebo vyřízením v evidenci.
      </p>
    );
  }

  const today = todayProp ?? new Date();
  const groups = groupByProject(items);

  const allSpans = items.map((m) => spanOf(m, today));
  const startMs = Math.min(...allSpans.map((s) => s.start.getTime()));
  const endMs = Math.max(today.getTime(), ...allSpans.map((s) => s.end.getTime()));
  const span = Math.max(DAY_MS, endMs - startMs);
  const pad = span * 0.02;
  const axisStart = new Date(startMs - pad);
  const axisEnd = new Date(endMs + pad);
  const axisSpan = axisEnd.getTime() - axisStart.getTime();

  const ticks = buildTicks(axisStart, axisEnd);
  const todayOffsetPct =
    ((today.getTime() - axisStart.getTime()) / axisSpan) * 100;

  function barColor(m: MaterialTimelineEntry, end: Date): string {
    if (m.resolved) {
      if (m.neededBy && m.resolvedAt && m.resolvedAt > m.neededBy) {
        // Resolved but late.
        return "bg-amber-500";
      }
      return "bg-emerald-500";
    }
    if (m.neededBy && end >= m.neededBy && today >= m.neededBy) {
      return "bg-red-500";
    }
    return "bg-primary";
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative h-5 border-b">
        {ticks.map((t, i) => (
          <span
            key={i}
            className="absolute top-0 flex h-full -translate-x-1/2 items-end gap-1 pb-px"
            style={{ left: `${t.offsetPct}%` }}
          >
            <span className="size-px h-2 bg-border" aria-hidden />
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {t.label}
            </span>
          </span>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <div key={g.projectId} className="flex flex-col gap-1">
            <Link
              href={`/projects/${g.projectId}?tab=reports`}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {g.projectName}
            </Link>
            <ul className="flex flex-col gap-1">
              {g.items.map((m) => {
                const { start, end } = spanOf(m, today);
                const leftPct =
                  ((start.getTime() - axisStart.getTime()) / axisSpan) * 100;
                const widthPct = Math.max(
                  0.5,
                  ((end.getTime() - start.getTime()) / axisSpan) * 100,
                );
                const tooltipParts = [
                  m.text,
                  `vytvořeno: ${formatDate(m.createdAt)}`,
                ];
                if (m.neededBy)
                  tooltipParts.push(`potřeba do: ${formatDate(m.neededBy)}`);
                if (m.resolvedAt)
                  tooltipParts.push(`vyřízeno: ${formatDate(m.resolvedAt)}`);
                const tooltip = tooltipParts.join(" · ");

                return (
                  <li
                    key={m.id}
                    className="grid grid-cols-[minmax(9rem,16rem)_1fr] items-center gap-2"
                  >
                    <span
                      className={
                        "truncate text-xs " +
                        (m.resolved
                          ? "text-muted-foreground line-through"
                          : "")
                      }
                      title={m.text}
                    >
                      {m.text}
                    </span>
                    <div className="relative h-4 rounded bg-muted/60">
                      {todayOffsetPct >= 0 && todayOffsetPct <= 100 && (
                        <div
                          className="absolute top-0 bottom-0 w-px bg-amber-500/80"
                          style={{ left: `${todayOffsetPct}%` }}
                          aria-hidden
                        />
                      )}
                      <span
                        title={tooltip}
                        aria-label={tooltip}
                        className={
                          "absolute top-0 h-4 rounded transition hover:opacity-90 " +
                          barColor(m, end)
                        }
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-primary" aria-hidden />
          otevřené
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-red-500" aria-hidden />
          po termínu
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-emerald-500" aria-hidden />
          vyřízené
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-sm bg-amber-500" aria-hidden />
          vyřízené po termínu
        </span>
      </div>
    </div>
  );
}
