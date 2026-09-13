"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
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
  const { execute, isExecuting } = useAction(deleteUserAction, {
    onSuccess: () => {
      toast.success(`${displayName} archivován.`);
    },
    onError: ({ error }) => {
      if (error.serverError) toast.error(error.serverError);
    },
  });

  function handleClick() {
    const confirmMsg =
      `Opravdu archivovat účet ${displayName}?\n\n` +
      `Uživatel se nebude moci přihlásit. Historická data ` +
      `(zápisy v denících, fotky, audit log) zůstávají zachována.`;
    if (!window.confirm(confirmMsg)) return;

    execute({ userId });
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      onClick={handleClick}
      disabled={isExecuting}
      aria-label={`Smazat účet ${displayName}`}
    >
      {isExecuting ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="size-4" aria-hidden />
      )}
      <span>Smazat</span>
    </Button>
  );
}
