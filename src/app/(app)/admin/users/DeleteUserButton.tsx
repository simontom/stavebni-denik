"use client";

import { useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { deleteUserAction } from "./actions";

interface Props {
  userId: string;
  displayName: string;
}

/**
 * Soft-delete (= archivuj) uživatele. Historická data zůstávají
 * (audit log, podepsané deníky, fotky) — jen už není v UI a nemůže
 * se přihlásit. Smazání se zaloguje do audit_log s akcí
 * `user.delete`.
 *
 * Server side blokuje:
 *   - smazání sebe sama (CannotDeleteSelfError),
 *   - smazání aktivního stavbyvedoucího (CannotDeleteSiteManagerError
 *     — operátor musí nejdřív přepnout siteManagerId na jiného BOSS).
 */
export function DeleteUserButton({ userId, displayName }: Props) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    const confirmMsg =
      `Opravdu archivovat účet ${displayName}?\n\n` +
      `Uživatel se nebude moci přihlásit. Historická data ` +
      `(zápisy v denících, fotky, audit log) zůstávají zachována.`;
    if (!window.confirm(confirmMsg)) return;

    const fd = new FormData();
    fd.append("userId", userId);
    startTransition(async () => {
      const result = await deleteUserAction(fd);
      if (!result.ok) {
        toast.error(result.error);
      } else {
        toast.success(`${displayName} archivován.`);
      }
    });
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      onClick={handleClick}
      disabled={pending}
      aria-label={`Smazat účet ${displayName}`}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="size-4" aria-hidden />
      )}
      <span>Smazat</span>
    </Button>
  );
}
