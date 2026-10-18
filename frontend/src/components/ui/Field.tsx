import { useId, type ReactNode } from "react";
import { FieldContext } from "./fieldContext";

/**
 * A labelled form control: the label is tied to the control (`htmlFor` and `id`), the hint and the error are tied to it
 * with `aria-describedby`, and the error is announced when it appears (`role="alert"`) and marks the control invalid.
 *
 *     <Field label="Přihlašovací jméno" hint="Jméno, které vám dal správce" error={problem}>
 *       <TextInput name="nickname" value={v} onChange={…} />
 *     </Field>
 *
 * [labelHidden] keeps the label for screen readers only, where the design has no room for it (it is still the control's name).
 */
export function Field({
  label,
  hint,
  error,
  labelHidden = false,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  labelHidden?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className={labelHidden ? "sr-only" : "text-ink mb-1 block text-sm font-medium"}>
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-ink-muted mb-1 text-sm">
          {hint}
        </p>
      )}
      <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>{children}</FieldContext.Provider>
      {error && (
        <p id={errorId} role="alert" className="text-danger-ink mt-1 text-sm font-medium">
          {error}
        </p>
      )}
    </div>
  );
}
