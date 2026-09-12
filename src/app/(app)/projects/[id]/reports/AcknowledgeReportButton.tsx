"use client";

import { useTransition } from "react";
import { Loader2, CheckCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

import { acknowledgeReportAction } from "./actions";

interface Props {
  reportId: string;
  projectId: string;
  date: string;
}

export function AcknowledgeReportButton({ reportId, projectId, date }: Props) {
  const [pending, startTransition] = useTransition();

  function handle() {
    const ok = window.confirm(
      "Opravdu potvrdit seznámení s tímto denním záznamem?\n\nToto je nevratná akce.",
    );
    if (!ok) return;
    const fd = new FormData();
    fd.append("reportId", reportId);
    fd.append("projectId", projectId);
    fd.append("date", date);
    startTransition(async () => {
      await acknowledgeReportAction(fd);
    });
  }

  return (
    <Button type="button" onClick={handle} disabled={pending} variant="secondary">
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <CheckCircle className="mr-2 size-4" aria-hidden />
      )}
      Potvrdit seznámení (Investor)
    </Button>
  );
}
