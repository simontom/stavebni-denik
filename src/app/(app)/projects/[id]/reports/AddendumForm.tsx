"use client";

import { useRef, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { addAddendumAction } from "./actions";

interface Props {
  reportId: string;
  projectId: string;
  date: string;
}

/**
 * Append-only addendum form for SIGNED reports. The day's original
 * content is frozen at sign time; this is the only way to extend it
 * (errata, missed entries). Allowed for BOSS / WORKER members.
 */
export function AddendumForm({ reportId, projectId, date }: Props) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  function handle(fd: FormData) {
    startTransition(async () => {
      await addAddendumAction(fd);
      ref.current?.reset();
    });
  }

  return (
    <form ref={ref} action={handle} className="grid gap-2">
      <input type="hidden" name="reportId" value={reportId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="date" value={date} />
      <Label htmlFor="addendum-text">Text dodatku</Label>
      <Textarea
        id="addendum-text"
        name="text"
        rows={3}
        required
        placeholder="Doplnění / oprava k podepsanému dni…"
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Přidat dodatek
        </Button>
      </div>
    </form>
  );
}
