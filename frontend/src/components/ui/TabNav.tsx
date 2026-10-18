import type { ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

/**
 * The tabs of a page that is several pages in one (a project: overview, entries, handovers, members). On a phone they are a
 * grid of two columns of large buttons, so none is cut off at the side and none has to be scrolled to; from `sm` up they are
 * the familiar row with an underline. Each tab is a real link (the address says where you are, Back works, a tab can be
 * opened in a new window); the current one says `aria-current="page"`.
 */
export function TabNav({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="sm:border-line grid grid-cols-2 gap-2 sm:flex sm:gap-x-8 sm:gap-y-0 sm:border-b">
      {children}
    </nav>
  );
}

export function TabLink({ active, className, ...rest }: LinkProps & { active: boolean }) {
  const tone = active
    ? "border-primary bg-primary-soft text-primary-ink sm:bg-transparent"
    : "border-input text-ink-muted hover:bg-neutral-soft hover:text-ink sm:border-transparent sm:hover:border-input sm:hover:bg-transparent";
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center justify-center rounded-md border px-3 text-center text-sm font-medium sm:min-h-0 sm:rounded-none sm:border-0 sm:border-b-2 sm:px-1 sm:pt-0 sm:pb-4 ${tone}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}
