import Link from "next/link";

import { formatDate } from "@/lib/dates";
import type { TimelineProject } from "@/server/services/dashboard";

interface Props {
  items: TimelineProject[];
  /** Used as the "today" marker AND as the right edge for ongoing projects. */
  today?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Tick {
  label: string;
  offsetPct: number;
}

/**
 * Pick a sensible tick step depending on the span. Reading 30 monthly
 * ticks on a 3-year project is noisy; one tick per quarter or year
 * keeps the axis legible regardless of how long the diary runs.
 */
function buildTicks(start: Date, end: Date): Tick[] {
  const totalMs = end.getTime() - start.getTime();
  if (totalMs <= 0) return [];
  const days = totalMs / DAY_MS;

  // step in months
  const step = days <= 200 ? 1 : days <= 800 ? 3 : 12;
  // For yearly ticks we still want the year label; for shorter steps
  // we add the month name in cs locale.
  const formatLabel = (d: Date) =>
    step >= 12
      ? d.toLocaleDateString("cs-CZ", {
          year: "numeric",
          timeZone: "Europe/Prague",
        })
      : d.toLocaleDateString("cs-CZ", {
          month: "short",
          year: "2-digit",
          timeZone: "Europe/Prague",
        });

  const ticks: Tick[] = [];
  const cursor = new Date(start);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  if (step >= 12) cursor.setMonth(0);
  // Align quarterly ticks to Jan/Apr/Jul/Oct.
  if (step === 3) cursor.setMonth(cursor.getMonth() - (cursor.getMonth() % 3));

  // Cap at ~12 ticks so the axis never crowds itself out.
  let safety = 16;
  while (cursor.getTime() <= end.getTime() && safety-- > 0) {
    const offsetPct = ((cursor.getTime() - start.getTime()) / totalMs) * 100;
    if (offsetPct >= -1 && offsetPct <= 101) {
      ticks.push({ label: formatLabel(cursor), offsetPct });
    }
    cursor.setMonth(cursor.getMonth() + step);
  }
  return ticks;
}

/**
 * Multi-project Gantt for the BOSS dashboard.
 *
 * Plain HTML/Tailwind — no client JS — uses percent-positioned bars
 * over a shared time axis. Ongoing projects (no endedAt) extend to
 * "today", which is also marked by an amber vertical line.
 */
export function ProjectsGantt({ items, today: todayProp }: Props) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Žádná zakázka nemá vyplněné datum zahájení — Gantt se zobrazí, jakmile
        vyplníte „Zahájení stavby“ alespoň u jedné zakázky.
      </p>
    );
  }

  const today = todayProp ?? new Date();
  const startMs = Math.min(...items.map((p) => p.startedAt.getTime()));
  const endMs = Math.max(
    today.getTime(),
    ...items.map((p) => (p.endedAt ?? today).getTime()),
  );
  // Add 2% padding on each side so bars at the very edge are visible.
  const span = Math.max(DAY_MS, endMs - startMs);
  const pad = span * 0.02;
  const axisStart = new Date(startMs - pad);
  const axisEnd = new Date(endMs + pad);
  const axisSpan = axisEnd.getTime() - axisStart.getTime();

  const ticks = buildTicks(axisStart, axisEnd);
  const todayOffsetPct =
    ((today.getTime() - axisStart.getTime()) / axisSpan) * 100;
  const showTodayMarker = todayOffsetPct >= 0 && todayOffsetPct <= 100;

  return (
    <div className="flex flex-col gap-2">
      {/* Axis */}
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

      {/* Rows */}
      <ul className="flex flex-col gap-1.5">
        {items.map((p) => {
          const endTime = (p.endedAt ?? today).getTime();
          const leftPct =
            ((p.startedAt.getTime() - axisStart.getTime()) / axisSpan) * 100;
          const widthPct = Math.max(
            0.5,
            ((endTime - p.startedAt.getTime()) / axisSpan) * 100,
          );
          const ongoing = p.endedAt === null || endTime >= today.getTime();
          const dateLabel = p.endedAt
            ? `${formatDate(p.startedAt)} – ${formatDate(p.endedAt)}`
            : `${formatDate(p.startedAt)} – probíhá`;

          return (
            <li
              key={p.id}
              className="grid grid-cols-[minmax(7rem,12rem)_1fr] items-center gap-2"
            >
              <Link
                href={`/projects/${p.id}`}
                className="truncate text-sm hover:underline"
                title={p.name}
              >
                {p.name}
              </Link>
              <div className="relative h-5 rounded bg-muted/60">
                {showTodayMarker && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-amber-500/80"
                    style={{ left: `${todayOffsetPct}%` }}
                    aria-hidden
                  />
                )}
                <Link
                  href={`/projects/${p.id}`}
                  title={dateLabel}
                  aria-label={`${p.name}: ${dateLabel}`}
                  className={
                    "absolute top-0 h-5 rounded transition hover:opacity-90 " +
                    (ongoing
                      ? "bg-primary"
                      : "bg-muted-foreground/40")
                  }
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {showTodayMarker && (
        <p className="text-[10px] text-muted-foreground">
          <span className="mr-1 inline-block h-2 w-px bg-amber-500 align-middle" />
          dnes
          <span className="mx-3 inline-block h-2 w-2 rounded-sm bg-primary align-middle" />
          probíhá
          <span className="mx-1 inline-block h-2 w-2 rounded-sm bg-muted-foreground/40 align-middle" />
          dokončeno
        </p>
      )}
    </div>
  );
}
