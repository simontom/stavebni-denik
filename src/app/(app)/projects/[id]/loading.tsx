import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton pro project detail — sticky tabs + content.
 * Used by `/projects/[id]` route during data fetch.
 */
export default function ProjectDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Tabs row */}
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>

      {/* Main content cards */}
      <Skeleton className="h-48" />
      <Skeleton className="h-64" />
      <Skeleton className="h-32" />
    </div>
  );
}
