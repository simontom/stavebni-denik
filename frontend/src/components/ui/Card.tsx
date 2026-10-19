import type { ComponentProps, ElementType } from "react";
import { cardClassName } from "./uiClasses";

type CardProps<T extends ElementType> = { as?: T; compact?: boolean; className?: string } & Omit<ComponentProps<T>, "as" | "className">;

/**
 * The white block that holds one thing on the grey page: a form, a list, the header of a project. Its padding is smaller on a
 * phone, where every pixel of width counts; `compact` keeps it small everywhere (a row of a list). `as` picks the element
 * (`section`, `li`, `article`), and `className` adds to it and wins over the card's own classes.
 */
export function Card<T extends ElementType = "div">({ as, compact = false, className, ...rest }: CardProps<T>) {
  const Tag: ElementType = as ?? "div";
  return <Tag className={cardClassName({ compact, className })} {...rest} />;
}
