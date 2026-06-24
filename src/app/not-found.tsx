import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FileSearch } from "lucide-react";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Stránka nenalezena",
};

/**
 * App-level 404. Triggered when `notFound()` is called or a path
 * doesn't match any route. Keeps the same layout chrome (header)
 * because Next.js auto-wraps `not-found.tsx` in the root layout.
 *
 * Avoids leaking what existed — the message is generic so it can't
 * tell a user whether a project id is valid but private (or just
 * a typo). Same wording for both "missing" and "forbidden" cases.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 py-12 text-center">
      <div className="grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
        <FileSearch className="size-8" aria-hidden />
      </div>
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">Stránka nenalezena</h1>
        <p className="text-muted-foreground">
          Cesta neexistuje nebo k ní nemáte přístup.
        </p>
      </div>
      <Button render={<Link href="/" />} variant="default">
        <ArrowLeft className="size-4" aria-hidden /> Zpět na úvod
      </Button>
    </div>
  );
}
