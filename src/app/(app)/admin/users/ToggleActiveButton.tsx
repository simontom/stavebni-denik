"use client";

import { useTransition } from "react";
import { Loader2, Power, PowerOff } from "lucide-react";

import { Button } from "@/components/ui/button";

import { setUserActiveAction } from "./actions";

interface Props {
  userId: string;
  isActive: boolean;
  displayName: string;
}

export function ToggleActiveButton({ userId, isActive, displayName }: Props) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    const confirmMsg = isActive
      ? `Opravdu deaktivovat účet ${displayName}? Uživatel se nebude moci přihlásit. Historická data zůstávají zachována.`
      : `Znovu aktivovat účet ${displayName}?`;
    if (!window.confirm(confirmMsg)) return;

    const fd = new FormData();
    fd.append("userId", userId);
    fd.append("isActive", isActive ? "0" : "1");
    startTransition(() => {
      void setUserActiveAction(fd);
    });
  }

  return (
    <Button
      type="button"
      variant={isActive ? "outline" : "default"}
      size="sm"
      onClick={handleClick}
      disabled={pending}
      aria-label={isActive ? "Deaktivovat účet" : "Aktivovat účet"}
    >
      {pending ? (
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
