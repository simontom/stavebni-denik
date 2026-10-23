import { useId, useState, type ReactNode } from "react";
import { useUnsavedWork } from "../lib/useUnsavedWork";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { useModal } from "./ui/modalContext";

/**
 * The temporary password of an account, shown once (after an account is made, and after an administrator resets a password): the
 * server will never show it again, so it must not be lost by a stray Escape or a click beside the dialog.
 *
 *  - It **cannot be dismissed** until the person ticks "Heslo jsem předal(a)": Escape does nothing, and "Hotovo" is off. After the
 *    tick both close it.
 *  - Until then it counts as unsaved work (`useUnsavedWork`): a link inside the application, or the browser's Back button, asks
 *    before leaving a page whose password could not be shown again.
 *  - The password lives in the page's own state (a person's name and a password, `onClosed` clears them) and in this dialog only: when
 *    the dialog is closed the page stops rendering it and the password is in no element and in no state. It is selectable (one click
 *    selects all of it), so it can be copied by hand; there is no clipboard button.
 *
 * [intro] says what to do with it (and how long it is valid).
 */
export function OneTimePasswordDialog({
  title,
  intro,
  nickname,
  password,
  onClosed,
}: {
  title: string;
  intro: ReactNode;
  nickname: string;
  password: string;
  onClosed: () => void;
}) {
  const [handedOver, setHandedOver] = useState(false);
  const hintId = useId();
  useUnsavedWork(!handedOver);
  return (
    <Modal title={title} description={intro} dismissible={handedOver} onCancel={onClosed} footer={<Done handedOver={handedOver} onClosed={onClosed} hintId={hintId} />}>
      <dl className="space-y-2 rounded-md border border-success bg-success-soft p-3 text-success-ink">
        <div>
          <dt className="text-xs font-semibold">Uživatel</dt>
          <dd className="font-mono text-sm font-semibold break-all">{nickname}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold">Heslo</dt>
          <dd data-testid="one-time-password" className="font-mono text-base font-semibold break-all select-all">
            {password}
          </dd>
        </div>
      </dl>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium text-ink">
        <input type="checkbox" checked={handedOver} onChange={(e) => setHandedOver(e.target.checked)} aria-describedby={hintId} className="h-5 w-5 shrink-0" />
        Heslo jsem předal(a)
      </label>
    </Modal>
  );
}

/** "Hotovo": inside the [Modal], so it can close it first and give the focus back to what opened it. */
function Done({ handedOver, onClosed, hintId }: { handedOver: boolean; onClosed: () => void; hintId: string }) {
  const modal = useModal();
  return (
    <>
      <p id={hintId} className="mr-auto min-w-0 self-center text-xs text-ink-muted">
        {handedOver ? "Heslo se po zavření už nezobrazí." : "Dokud heslo nepředáte, dialog nejde zavřít: heslo se už nezobrazí."}
      </p>
      <Button disabled={!handedOver} onClick={() => modal.close(onClosed, { restoreFocus: true })}>
        Hotovo
      </Button>
    </>
  );
}
