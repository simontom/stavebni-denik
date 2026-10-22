import type { ReactNode } from "react";
import { bannerClassName } from "./uiClasses";

export type BannerTone = "info" | "success" | "warning" | "danger";

/**
 * A message that stands on the page: an error, a warning, a confirmation, a notice. An error is announced the moment it
 * appears (`role="alert"`); the others are polite (`role="status"`). The text is the message; the tone is only a help. [role]
 * overrides that for the odd case (a warning that must interrupt).
 */
export function Banner({
  tone = "info",
  title,
  role,
  className,
  children,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  role?: "alert" | "status";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div role={role ?? (tone === "danger" ? "alert" : "status")} className={bannerClassName({ tone, className })}>
      {title && <p className="font-semibold">{title}</p>}
      {children}
    </div>
  );
}
