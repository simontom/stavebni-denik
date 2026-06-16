"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { verifyAuditAction, type VerifyResultJson } from "./actions";

/**
 * BOSS-only button that runs the full audit-log hash-chain verification
 * via the `verifyAuditAction` server action and surfaces the outcome
 * both as a toast and inline beneath the button.
 */
export function VerifyChainButton() {
  const [isPending, startTransition] = useTransition();
  const [last, setLast] = useState<VerifyResultJson | null>(null);

  function onVerify() {
    startTransition(async () => {
      try {
        const result = await verifyAuditAction();
        setLast(result);
        if (result.ok) {
          toast.success(
            `Řetěz je neporušený — zkontrolováno ${result.totalRows} záznamů.`,
          );
        } else {
          toast.error(
            `Porušená integrita u záznamu #${result.brokenAtId ?? "?"}.`,
          );
        }
      } catch {
        toast.error("Ověření selhalo. Zkuste to prosím znovu.");
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        variant="outline"
        size="sm"
        onClick={onVerify}
        disabled={isPending}
      >
        {isPending ? "Ověřuji…" : "Ověřit integritu řetězu"}
      </Button>
      {last && (
        <span
          className={
            last.ok
              ? "text-xs text-muted-foreground"
              : "text-xs font-medium text-destructive"
          }
        >
          {last.ok
            ? `OK · zkontrolováno ${last.totalRows} záznamů`
            : `CHYBA u #${last.brokenAtId ?? "?"} · ${last.reason ?? "porušená integrita"}`}
        </span>
      )}
    </div>
  );
}
