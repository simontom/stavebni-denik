import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton pro report detail — víc cards (weather, workers,
 * description, visits, materials, photos).
 */
export default function ReportLoading() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Skeleton className="h-4 w-32" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-56" />
      </div>
      {/* 6 typical cards: weather, workers, description, remarks, visits, materials */}
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-40" />
      ))}
      <Skeleton className="h-72" /> {/* photos grid */}
    </div>
  );
}
