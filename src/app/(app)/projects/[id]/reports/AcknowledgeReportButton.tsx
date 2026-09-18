"use client";

import { CheckCircle, Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { acknowledgeReportAction } from "./actions";

interface Props {
  reportId: string;
  projectId: string;
  date: string;
}

export function AcknowledgeReportButton({ reportId, projectId, date }: Props) {
  const { execute, isPending } = useAction(acknowledgeReportAction, {
    onSuccess: () => {
      toast.success("Seznámení se záznamem bylo potvrzeno.");
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? "Potvrzení seznámení se nezdařilo.");
    },
  });

  function handle() {
    const ok = window.confirm(
      "Opravdu potvrdit seznámení s tímto denním záznamem?\n\nToto je nevratná akce.",
    );
    if (!ok) return;
    execute({ reportId, projectId, date });
  }

  return (
    <Button type="button" onClick={handle} disabled={isPending} variant="secondary">
      {isPending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <CheckCircle className="mr-2 size-4" aria-hidden />
      )}
      Potvrdit seznámení (Investor)
    </Button>
  );
}
