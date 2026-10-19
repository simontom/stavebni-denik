import type { ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { tabLinkClassName } from "./uiClasses";

/**
 * The tabs of a page that is several pages in one (a project: overview, entries, handovers, members). On a phone they are a
 * grid of two columns of large buttons, so none is cut off at the side and none has to be scrolled to; from `sm` up they are
 * the familiar row with an underline. Each tab is a real link (the address says where you are, Back works, a tab can be
 * opened in a new window); the current one says `aria-current="page"` and, on a phone, is bold and underlined (not only coloured).
 */
export function TabNav({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="grid grid-cols-2 gap-2 sm:flex sm:gap-x-8 sm:gap-y-0 sm:border-b sm:border-line">
      {children}
    </nav>
  );
}

export function TabLink({ active, className, ...rest }: LinkProps & { active: boolean }) {
  return <Link aria-current={active ? "page" : undefined} className={tabLinkClassName({ active, className })} {...rest} />;
}
