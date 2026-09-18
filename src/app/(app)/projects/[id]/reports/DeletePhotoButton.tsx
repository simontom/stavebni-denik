"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { deletePhotoAction } from "./actions";

interface Props {
  photoId: string;
  projectId: string;
  date: string;
  /** Filename / index used in the confirmation dialog. */
  caption: string;
}

/**
 * BOSS-only delete button. Soft-deletes the photo via the audited
 * `deletePhotoAction` server action. The original files remain on
 * disk so the chain of custody is preserved (see comments in
 * `services/photos.ts`).
 */
export function DeletePhotoButton({ photoId, projectId, date, caption }: Props) {
  const { execute, isPending } = useAction(deletePhotoAction, {
    onSuccess: () => {
      toast.success("Fotka byla odstraněna.");
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? "Odstranění fotky se nezdařilo.");
    },
  });

  function handle() {
    const ok = window.confirm(`Opravdu odstranit fotku ${caption}?`);
    if (!ok) return;
    execute({ photoId, projectId, date });
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="icon"
      disabled={isPending}
      onClick={handle}
      aria-label="Odstranit fotku"
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="size-4" aria-hidden />
      )}
    </Button>
  );
}
