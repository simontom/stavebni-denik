import Link from "next/link";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  query: string;
  status: "all" | "signed" | "unsigned";
  /** Total reports before filtering — shown as context next to the input. */
  totalCount: number;
  /** Reports that match the current filters. */
  filteredCount: number;
}

const STATUS_OPTIONS: Array<{ value: Props["status"]; label: string }> = [
  { value: "all", label: "Vše" },
  { value: "unsigned", label: "Nepodepsané" },
  { value: "signed", label: "Podepsané" },
];

/**
 * Plain server-rendered GET form that updates the project-detail URL
 * with `?tab=reports&q=…&status=…`. The page re-renders with the
 * filter applied — no client JS, no hydration cost.
 *
 * The status filter is a row of `<Link>` chips (cheap to render, easy
 * to share via URL) instead of a `<select>` so the active option is
 * visible at a glance on a phone screen.
 */
export function ReportsFilterBar({
  projectId,
  query,
  status,
  totalCount,
  filteredCount,
}: Props) {
  const isFiltered = query.length > 0 || status !== "all";

  return (
    <div className="flex flex-col gap-3">
      <form
        method="GET"
        action={`/projects/${projectId}`}
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
      >
        <input type="hidden" name="tab" value="reports" />
        <input type="hidden" name="status" value={status} />
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="reports-q">Hledat (datum, autor, počasí, popis)</Label>
          <div className="relative">
            <Search
              className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="reports-q"
              name="q"
              type="search"
              defaultValue={query}
              placeholder="napr. 2026-06-15, beton, Karel"
              className="pl-8"
            />
          </div>
        </div>
        <div className="flex gap-2 sm:items-end">
          <Button type="submit">Hledat</Button>
          {isFiltered && (
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  href={`/projects/${projectId}?tab=reports`}
                  aria-label="Vyčistit filtry"
                />
              }
            >
              <X className="size-4" aria-hidden /> Vyčistit
            </Button>
          )}
        </div>
      </form>

      <nav
        className="flex flex-wrap gap-1 text-sm"
        aria-label="Filtr podle stavu"
      >
        {STATUS_OPTIONS.map((opt) => {
          const params = new URLSearchParams({ tab: "reports" });
          if (query.length > 0) params.set("q", query);
          if (opt.value !== "all") params.set("status", opt.value);
          const active = opt.value === status;
          return (
            <Link
              key={opt.value}
              href={`/projects/${projectId}?${params.toString()}`}
              className={
                active
                  ? "rounded-full bg-primary px-3 py-1 text-primary-foreground"
                  : "rounded-full border px-3 py-1 text-muted-foreground hover:text-foreground"
              }
              aria-current={active ? "true" : undefined}
            >
              {opt.label}
            </Link>
          );
        })}
        <span className="ml-auto self-center text-xs text-muted-foreground">
          {isFiltered
            ? `${filteredCount} z ${totalCount} záznamů`
            : `${totalCount} záznamů`}
        </span>
      </nav>
    </div>
  );
}
