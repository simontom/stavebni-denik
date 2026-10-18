import type { ComponentProps, ElementType } from "react";

type CardProps<T extends ElementType> = { as?: T; className?: string } & Omit<ComponentProps<T>, "as" | "className">;

/**
 * The white block that holds one thing on the grey page: a form, a list, the header of a project. Its padding is smaller on a
 * phone, where every pixel of width counts. `as` picks the element (`section`, `li`, `article`), and `className` adds to it.
 */
export function Card<T extends ElementType = "div">({ as, className, ...rest }: CardProps<T>) {
  const Tag: ElementType = as ?? "div";
  return <Tag className={`rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-6${className ? ` ${className}` : ""}`} {...rest} />;
}
