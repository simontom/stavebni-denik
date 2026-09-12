import { cn } from "@/lib/utils";

/**
 * Reusable loading skeleton — animated `<div>` placeholder.
 * Used in `loading.tsx` files and inside Suspense boundaries.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("bg-muted animate-pulse rounded-md", className)} aria-hidden {...props} />
  );
}
