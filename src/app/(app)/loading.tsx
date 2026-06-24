import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton pro / (dashboard) — zobrazuje se během načítání
 * dashboard dat (active projects, unsigned reports, materials Gantt).
 * Next.js auto-Suspense při navigaci.
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-4 w-96" />
      </header>

      {/* Stat cards row */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </section>

      {/* Two-column section */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </section>

      {/* Gantt + recent activity */}
      <Skeleton className="h-56" />
      <Skeleton className="h-72" />
      <Skeleton className="h-48" />
    </div>
  );
}
