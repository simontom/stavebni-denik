import type { ComponentProps, ElementType } from "react";

type CardProps<T extends ElementType> = { as?: T; compact?: boolean; className?: string } & Omit<ComponentProps<T>, "as" | "className">;

/**
 * The white block that holds one thing on the grey page: a form, a list, the header of a project. Its padding is smaller on a
 * phone, where every pixel of width counts; `compact` keeps it small everywhere (a row of a list). `as` picks the element
 * (`section`, `li`, `article`), and `className` adds to it (never padding: that is what `compact` is for).
 */
export function Card<T extends ElementType = "div">({ as, compact = false, className, ...rest }: CardProps<T>) {
  const Tag: ElementType = as ?? "div";
  return <Tag className={`rounded-lg border border-line bg-surface shadow-sm ${compact ? "p-4" : "p-4 sm:p-6"}${className ? ` ${className}` : ""}`} {...rest} />;
}
