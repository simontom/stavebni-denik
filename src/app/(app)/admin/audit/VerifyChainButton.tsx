"use client";

import { useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { verifyAuditAction, type VerifyResultJson } from "./actions";

/**
 * BOSS-only button that runs the full audit-log hash-chain verification
 * via the `verifyAuditAction` server action and surfaces the outcome
 * both as a toast and inline beneath the button.
 */
export function VerifyChainButton() {
  const [last, setLast] = useState<VerifyResultJson | null>(null);

  const { execute, isExecuting } = useAction(verifyAuditAction, {
    onSuccess: ({ data }) => {
      if (!data) return;
      setLast(data);
      if (data.ok) {
        toast.success(`Řetěz je neporušený — zkontrolováno ${data.totalRows} záznamů.`);
      } else {
        toast.error(`Porušená integrita u záznamu #${data.brokenAtId ?? "?"}.`);
      }
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? "Ověření selhalo. Zkuste to prosím znovu.");
    },
  });

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button variant="outline" size="sm" onClick={() => execute()} disabled={isExecuting}>
        {isExecuting ? "Ověřuji…" : "Ověřit integritu řetězu"}
      </Button>
      {last && (
        <span
          className={
            last.ok ? "text-muted-foreground text-xs" : "text-destructive text-xs font-medium"
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
