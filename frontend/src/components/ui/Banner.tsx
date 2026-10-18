import type { ReactNode } from "react";

export type BannerTone = "info" | "success" | "warning" | "danger";

const tones: Record<BannerTone, string> = {
  info: "border-info bg-info-soft text-info-ink",
  success: "border-success bg-success-soft text-success-ink",
  warning: "border-warning bg-warning-soft text-warning-ink",
  danger: "border-danger bg-danger-soft text-danger-ink",
};

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
    <div role={role ?? (tone === "danger" ? "alert" : "status")} className={`rounded-md border-l-4 p-3 text-sm ${tones[tone]}${className ? ` ${className}` : ""}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children}
    </div>
  );
}
