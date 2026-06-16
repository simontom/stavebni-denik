"use client";

import { useTransition } from "react";
import { Archive, ArchiveRestore, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { archiveProjectAction, restoreProjectAction } from "./actions";

interface Props {
  projectId: string;
  projectName: string;
  archived: boolean;
}

export function ProjectStatusButton({
  projectId,
  projectName,
  archived,
}: Props) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    const msg = archived
      ? `Obnovit zakázku „${projectName}“ mezi aktivní?`
      : `Archivovat zakázku „${projectName}“? Zmizí z aktivního seznamu, deník ale zůstává zachován a lze ji kdykoli obnovit.`;
    if (!window.confirm(msg)) return;

    const fd = new FormData();
    fd.append("projectId", projectId);
    startTransition(() => {
      void (archived ? restoreProjectAction(fd) : archiveProjectAction(fd));
    });
  }

  return (
    <Button
      type="button"
      variant={archived ? "default" : "outline"}
      size="sm"
      onClick={handleClick}
      disabled={pending}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : archived ? (
        <ArchiveRestore className="size-4" aria-hidden />
      ) : (
        <Archive className="size-4" aria-hidden />
      )}
      {archived ? "Obnovit" : "Archivovat"}
    </Button>
  );
}
