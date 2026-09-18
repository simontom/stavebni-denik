"use client";

import { useRef } from "react";
import { Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { toast } from "sonner";

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
  const { execute, isPending } = useAction(addAddendumAction, {
    onSuccess: () => {
      ref.current?.reset();
      toast.success("Dodatek byl přidán.");
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? "Přidání dodatku se nezdařilo.");
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const text = String(fd.get("text") ?? "").trim();
    if (!text) return;
    execute({ reportId, projectId, date, text });
  }

  return (
    <form ref={ref} onSubmit={handleSubmit} className="grid gap-2">
      <Label htmlFor="addendum-text">Text dodatku</Label>
      <Textarea
        id="addendum-text"
        name="text"
        rows={3}
        required
        placeholder="Doplnění / oprava k podepsanému dni…"
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Přidat dodatek
        </Button>
      </div>
    </form>
  );
}
