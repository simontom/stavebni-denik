import { cn } from "@/lib/utils";

/**
 * Reusable loading skeleton — animated `<div>` placeholder.
 * Used in `loading.tsx` files and inside Suspense boundaries.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted",
        className,
      )}
      aria-hidden
      {...props}
    />
  );
}
