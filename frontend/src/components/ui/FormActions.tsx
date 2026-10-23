import { Button } from "./Button";
import type { ButtonVariant } from "./buttonClasses";
import { useModal } from "./modalContext";

/**
 * The two buttons of a form in a [Modal] (its `footer`): "Zrušit", which cancels the way Escape does (so a dialog with typed text asks
 * before it throws the text away, and one that is saving does not move), and the one that submits the form. The form is named by
 * [formId] (`<form id=…>`): the submit button is outside it, in the footer, and says which form it belongs to.
 *
 * [busy] is an action under way. Both buttons are then off, but they are `aria-disabled`, not `disabled`: a disabled button that has the
 * focus loses it, and after a refusal the person who pressed Enter on "Uložit" would find the focus on the page and a second Enter would
 * do nothing. The submit button is not allowed to send the form while busy (the form's own handler ignores a second send as well), and
 * the dialog itself must be `dismissible={false}` meanwhile. When the server has not answered for long ([stalled], `useStalled`) "Zrušit"
 * is "Zavřít", on again, and the dialog is dismissible; the dialog says "Server neodpovídá" (`StalledNotice`). [canSubmit] is false
 * while the form cannot be sent yet.
 */
export function FormActions({
  formId,
  submitLabel,
  cancelLabel = "Zrušit",
  busy = false,
  stalled = false,
  canSubmit = true,
  submitVariant = "primary",
}: {
  formId: string;
  submitLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  stalled?: boolean;
  canSubmit?: boolean;
  submitVariant?: ButtonVariant;
}) {
  const modal = useModal();
  const cancelOff = busy && !stalled;
  return (
    <>
      <Button
        variant="secondary"
        aria-disabled={cancelOff || undefined}
        onClick={() => {
          if (!cancelOff) modal.cancel();
        }}
      >
        {stalled ? "Zavřít" : cancelLabel}
      </Button>
      <Button
        type="submit"
        form={formId}
        variant={submitVariant}
        disabled={!canSubmit}
        aria-disabled={busy || undefined}
        onClick={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        {submitLabel}
      </Button>
    </>
  );
}
