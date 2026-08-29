"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";

/**
 * Top-level error boundary — chytá uncaught runtime errors v server
 * komponentách i client componentech. Next.js zavolá automaticky.
 *
 * User vidí přátelskou zprávu + reset button (Next ji použije pro
 * client retry). Server-side i client-side errory se zapíší přes
 * náš logger.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("app.error", error, { digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 py-12 text-center">
      <div className="grid size-16 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-8" aria-hidden />
      </div>
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Něco se pokazilo</h1>
        <p className="text-muted-foreground">
          Při zpracování požadavku došlo k chybě. Zkuste to prosím znovu.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground font-mono">
            Kód: {error.digest}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset} variant="default">
          <RotateCw className="size-4" aria-hidden /> Zkusit znovu
        </Button>
        <Button render={<Link href="/" />} variant="outline">
          Zpět na úvod
        </Button>
      </div>
    </div>
  );
}
