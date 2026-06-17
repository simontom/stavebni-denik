"use client";

import { useTransition } from "react";
import { Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";

import { signReportAction } from "./actions";

interface Props {
  reportId: string;
  projectId: string;
  date: string;
}

/**
 * BOSS-only sign+lock button. After confirmation, calls the audited
 * `signReportAction` and the server rerenders the page in its locked
 * state (edit hidden, addendum form shown).
 *
 * The confirm dialog is intentionally explicit — once a report is
 * signed, only addenda can be added; the original content is legally
 * frozen.
 */
export function SignReportButton({ reportId, projectId, date }: Props) {
  const [pending, startTransition] = useTransition();

  function handle() {
    const ok = window.confirm(
      "Opravdu podepsat a uzamknout tento denní záznam?\n\nPo podpisu nebude možné obsah dne dále upravovat — opravy půjdou jen formou dodatku.",
    );
    if (!ok) return;
    const fd = new FormData();
    fd.append("reportId", reportId);
    fd.append("projectId", projectId);
    fd.append("date", date);
    startTransition(async () => {
      await signReportAction(fd);
    });
  }

  return (
    <Button type="button" onClick={handle} disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Lock className="size-4" aria-hidden />
      )}
      Podepsat a uzamknout
    </Button>
  );
}
