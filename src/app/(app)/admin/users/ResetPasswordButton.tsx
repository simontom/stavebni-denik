"use client";

import { useState, useTransition } from "react";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { resetUserPasswordAction } from "./actions";

interface Props {
  userId: string;
  displayName: string;
}

/**
 * Admin akce: vygeneruje nové heslo pro uživatele (typicky když
 * zapomněl). Heslo se zobrazí v modalu JEDNOU — admin ho předá
 * uživateli bezpečně. User pak při dalším loginu projde
 * /first-password-change flow (`mustChangePwd=true` po resetu).
 *
 * Bezpečnost:
 *   - Server-side blokuje reset vlastního hesla přes tuhle cestu
 *     (vrací error toast).
 *   - Aktivní session usera se revokují → starým heslem už cesta
 *     zpět neexistuje.
 *   - Audit log `user.password-reset` (actor=admin, target=user).
 */
export function ResetPasswordButton({ userId, displayName }: Props) {
  const [pending, startTransition] = useTransition();
  // Stav modalu se zobrazeným heslem. Když je null, modal je zavřený.
  const [generated, setGenerated] = useState<{
    password: string;
    nickname: string;
    displayName: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  function handleClick() {
    const confirmMsg =
      `Vygenerovat NOVÉ heslo pro ${displayName}?\n\n` +
      `Staré heslo přestane fungovat okamžitě. Všechny aktivní ` +
      `session se odhlásí. Nové heslo se zobrazí JEDNOU — předej ` +
      `ho uživateli bezpečně.`;
    if (!window.confirm(confirmMsg)) return;

    const fd = new FormData();
    fd.append("userId", userId);
    startTransition(async () => {
      const result = await resetUserPasswordAction(fd);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setGenerated({
        password: result.generatedPassword,
        nickname: result.nickname,
        displayName: result.displayName,
      });
      setCopied(false);
    });
  }

  function handleCopy() {
    if (!generated) return;
    navigator.clipboard
      .writeText(generated.password)
      .then(() => {
        setCopied(true);
        toast.success("Heslo zkopírováno do schránky.");
      })
      .catch(() => toast.error("Zkopírování se nezdařilo."));
  }

  function handleClose(next: boolean) {
    if (!next && generated) {
      const confirmed = window.confirm(
        "Heslo se po zavření okna už nikdy znovu nezobrazí. Opravdu zavřít?",
      );
      if (!confirmed) return;
    }
    if (!next) setGenerated(null);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={pending}
        aria-label={`Reset hesla ${displayName}`}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <KeyRound className="size-4" aria-hidden />
        )}
        <span>Reset hesla</span>
      </Button>

      <Dialog open={generated !== null} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Heslo vygenerováno</DialogTitle>
            <DialogDescription>
              Předejte tyto údaje uživateli{" "}
              <strong>{generated?.displayName}</strong> bezpečným
              kanálem (osobně, šifrovaná zpráva).{" "}
              <strong>Heslo se nikdy znovu nezobrazí.</strong>
            </DialogDescription>
          </DialogHeader>
          {generated && (
            <div className="flex flex-col gap-3">
              <div className="grid gap-2">
                <Label>Přihlašovací jméno</Label>
                <Input value={generated.nickname} readOnly />
              </div>
              <div className="grid gap-2">
                <Label>Nové heslo</Label>
                <div className="flex gap-2">
                  <Input
                    value={generated.password}
                    readOnly
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopy}
                    aria-label="Zkopírovat heslo"
                  >
                    {copied ? (
                      <Check className="size-4" aria-hidden />
                    ) : (
                      <Copy className="size-4" aria-hidden />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Uživatel bude při dalším přihlášení vyzván ke změně
                  hesla.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              onClick={() => handleClose(false)}
              disabled={!copied}
              title={!copied ? "Nejdřív zkopíruj heslo" : undefined}
            >
              Hotovo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
