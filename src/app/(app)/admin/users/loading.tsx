import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton pro /admin/users — table-like layout.
 */
export default function AdminUsersLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-10 w-44" />
      </div>
      {/* Table rows skeleton */}
      <div className="rounded-md border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b p-3 last:border-b-0"
          >
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-12" />
            <Skeleton className="ml-auto h-9 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
