"use client";

import { useTransition } from "react";
import { Loader2, Power, PowerOff } from "lucide-react";
import { toast } from "sonner";

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
    // Use async callback so React 19 tracks the Promise — without
    // `await` inside startTransition the call would fire-and-forget
    // and revalidatePath could land after the transition ended.
    startTransition(async () => {
      const result = await setUserActiveAction(fd);
      if (!result.ok) {
        toast.error(result.error);
      } else {
        toast.success(
          isActive
            ? `${displayName} deaktivován.`
            : `${displayName} aktivován.`,
        );
      }
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
