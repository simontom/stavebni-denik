"use client";

import { Loader2, Power, PowerOff } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { setUserActiveAction } from "./actions";

interface Props {
  userId: string;
  isActive: boolean;
  displayName: string;
}

export function ToggleActiveButton({ userId, isActive, displayName }: Props) {
  const { execute, isExecuting } = useAction(setUserActiveAction, {
    onSuccess: () => {
      toast.success(isActive ? `${displayName} deaktivován.` : `${displayName} aktivován.`);
    },
    onError: ({ error }) => {
      if (error.serverError) toast.error(error.serverError);
    },
  });

  function handleClick() {
    const confirmMsg = isActive
      ? `Opravdu deaktivovat účet ${displayName}? Uživatel se nebude moci přihlásit. Historická data zůstávají zachována.`
      : `Znovu aktivovat účet ${displayName}?`;
    if (!window.confirm(confirmMsg)) return;

    execute({ userId, isActive: !isActive });
  }

  return (
    <Button
      type="button"
      variant={isActive ? "outline" : "default"}
      size="sm"
      onClick={handleClick}
      disabled={isExecuting}
      aria-label={isActive ? "Deaktivovat účet" : "Aktivovat účet"}
    >
      {isExecuting ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : isActive ? (
        <PowerOff className="size-4" aria-hidden />
      ) : (
        <Power className="size-4" aria-hidden />
      )}
      <span>{isActive ? "Deaktivovat" : "Aktivovat"}</span>
    </Button>
  );
}
