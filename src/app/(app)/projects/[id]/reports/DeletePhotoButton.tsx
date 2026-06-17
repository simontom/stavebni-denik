"use client";

import { useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";

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
  const [pending, startTransition] = useTransition();

  function handle() {
    const ok = window.confirm(`Opravdu odstranit fotku ${caption}?`);
    if (!ok) return;
    const fd = new FormData();
    fd.append("photoId", photoId);
    fd.append("projectId", projectId);
    fd.append("date", date);
    startTransition(async () => {
      await deletePhotoAction(fd);
    });
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="icon"
      disabled={pending}
      onClick={handle}
      aria-label="Odstranit fotku"
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="size-4" aria-hidden />
      )}
    </Button>
  );
}
