import type { ComponentProps } from "react";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonClasses";

export type ButtonProps = ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize; block?: boolean };

/** A button. `type` is "button" unless said otherwise, so a button inside a form does not submit it by accident. */
export function Button({ variant, size, block, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClasses({ variant, size, block, className })} {...rest} />;
}
