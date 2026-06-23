import Link from "next/link";
import { AlertTriangle, Calendar, Check, Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateInput } from "@/lib/dates";
import type { MaterialGanttItem } from "@/server/services/projects";

/**
 * Materiálový "Gantt" pro celou zakázku — vizuální timeline všech
 * MaterialNeed položek napříč denními reporty. Zobrazený jako
 * vertikální seznam seskupený podle `neededBy` (nulls last).
 *
 * Použití: tab "Materiál" na project detail. RBAC kontroluje
 * volající server component (caller skryje pro GUEST roli).
 *
 * Vizuál:
 *   - barevný badge `Otevřená` / `Hotová` + ikona,
 *   - badge `Opožděno` (červený) když open + neededBy < dnes,
 *   - odkaz na zdrojový report (formátovaný datum).
 *
 * Žádný interaktivní state — toggle/resolve se dělá v reportu, kam
 * vede link. Tahle stránka je read-only přehled napříč zakázkou.
 */

interface Props {
  projectId: string;
  items: MaterialGanttItem[];
}

interface Group {
  /** `null` = bez termínu, ostatní = startOfDay ISO YYYY-MM-DD. */
  key: string | null;
  /** "Bez termínu" nebo formátovaný den (např. "23.06.2026 (úterý)"). */
  label: string;
  items: MaterialGanttItem[];
}

function groupByNeededBy(items: MaterialGanttItem[]): Group[] {
  const byDay = new Map<string | null, MaterialGanttItem[]>();
  for (const item of items) {
    const key = item.neededBy ? formatDateInput(item.neededBy) : null;
    const bucket = byDay.get(key) ?? [];
    bucket.push(item);
    byDay.set(key, bucket);
  }
  const groups: Group[] = [];
  // Datované první (chronologicky), pak skupina "bez termínu".
  for (const [key, value] of byDay) {
    if (key === null) continue;
    const wd = new Intl.DateTimeFormat("cs-CZ", {
      timeZone: "Europe/Prague",
      weekday: "long",
    }).format(value[0]!.neededBy as Date);
    groups.push({
      key,
      label: `${formatDate(value[0]!.neededBy as Date)} (${wd})`,
      items: value,
    });
  }
  groups.sort((a, b) => a.key!.localeCompare(b.key!));
  if (byDay.has(null)) {
    groups.push({
      key: null,
      label: "Bez termínu",
      items: byDay.get(null) as MaterialGanttItem[],
    });
  }
  return groups;
}

function isOverdue(item: MaterialGanttItem, now: Date): boolean {
  if (item.resolved) return false;
  if (!item.neededBy) return false;
  return item.neededBy.getTime() < now.getTime();
}

export function MaterialGantt({ projectId, items }: Props) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        Žádné materiálové položky. Přidávají se v denních záznamech v
        sekci „Materiál na další dny&ldquo;.
      </div>
    );
  }

  const now = new Date();
  const groups = groupByNeededBy(items);
  const open = items.filter((i) => !i.resolved).length;
  const overdue = items.filter((i) => isOverdue(i, now)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <Badge variant="secondary" className="gap-1.5">
          <Package className="size-3" aria-hidden />
          {items.length} celkem
        </Badge>
        {open > 0 && (
          <Badge variant="default" className="gap-1.5">
            {open} otevřených
          </Badge>
        )}
        {overdue > 0 && (
          <Badge variant="destructive" className="gap-1.5">
            <AlertTriangle className="size-3" aria-hidden />
            {overdue} opožděných
          </Badge>
        )}
      </div>

      <ul className="flex flex-col gap-3">
        {groups.map((group) => (
          <li
            key={group.key ?? "no-due-date"}
            className="rounded-md border bg-card"
          >
            <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 text-sm font-medium">
              <Calendar className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{group.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {group.items.length}{" "}
                {group.items.length === 1
                  ? "položka"
                  : group.items.length < 5
                    ? "položky"
                    : "položek"}
              </span>
            </div>
            <ul className="flex flex-col divide-y">
              {group.items.map((item) => {
                const overdueRow = isOverdue(item, now);
                return (
                  <li
                    key={item.id}
                    className={
                      "flex items-start gap-3 px-3 py-2 text-sm " +
                      (item.resolved
                        ? "bg-muted/30 text-muted-foreground"
                        : overdueRow
                          ? "bg-destructive/5"
                          : "")
                    }
                  >
                    <div className="mt-0.5 shrink-0">
                      {item.resolved ? (
                        <Check
                          className="size-4 text-emerald-700 dark:text-emerald-400"
                          aria-hidden
                        />
                      ) : overdueRow ? (
                        <AlertTriangle
                          className="size-4 text-destructive"
                          aria-hidden
                        />
                      ) : (
                        <Package
                          className="size-4 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        className={
                          item.resolved ? "line-through" : "font-medium"
                        }
                      >
                        {item.text}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Zdroj:{" "}
                        <Link
                          href={`/projects/${projectId}/reports/${formatDateInput(item.reportDate)}`}
                          className="underline-offset-2 hover:underline"
                        >
                          záznam {formatDate(item.reportDate)}
                        </Link>
                      </p>
                    </div>
                    <div className="shrink-0">
                      {item.resolved ? (
                        <Badge variant="outline" className="gap-1">
                          <Check className="size-3" aria-hidden />
                          Hotovo
                        </Badge>
                      ) : overdueRow ? (
                        <Badge variant="destructive">Opožděno</Badge>
                      ) : (
                        <Badge variant="default">Otevřená</Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
