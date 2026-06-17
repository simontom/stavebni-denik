"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface UploadFailure {
  filename: string;
  reason: string;
}

interface UploadResponse {
  uploaded?: { id: string }[];
  failed?: UploadFailure[];
  error?: string;
}

interface Props {
  reportId: string;
}

/**
 * Multi-file photo uploader. Reads `<input type="file" multiple>` and
 * POSTs everything to `/api/photos/upload` as multipart/form-data; on
 * success calls `router.refresh()` so the freshly created photos appear
 * in the gallery without a full page reload. Reports per-file errors
 * inline (image format unsupported, file too big, …) without dropping
 * the successful uploads.
 */
export function PhotoUploader({ reportId }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [failures, setFailures] = useState<UploadFailure[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
    setFailures([]);
    setServerError(null);
  }

  function clear() {
    setFiles([]);
    setFailures([]);
    setServerError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function upload() {
    if (files.length === 0) return;
    setFailures([]);
    setServerError(null);

    const form = new FormData();
    form.append("reportId", reportId);
    for (const f of files) form.append("files", f);

    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch("/api/photos/upload", {
          method: "POST",
          body: form,
        });
      } catch (err) {
        setServerError(
          err instanceof Error ? err.message : "Nahrání selhalo.",
        );
        return;
      }

      let json: UploadResponse | null = null;
      try {
        json = (await res.json()) as UploadResponse;
      } catch {
        // Non-JSON response — fall through to status handling.
      }

      if (res.status === 401) {
        setServerError("Pro nahrávání fotek musíte být přihlášeni.");
        return;
      }
      if (res.status === 403 || res.status === 404 || res.status === 409) {
        setServerError(json?.error ?? "Nahrávání není povoleno.");
        return;
      }
      if (!res.ok && (!json || (json.uploaded ?? []).length === 0)) {
        setServerError(json?.error ?? `Nahrání selhalo (HTTP ${res.status}).`);
        if (json?.failed) setFailures(json.failed);
        return;
      }

      if (json?.failed?.length) setFailures(json.failed);

      const allSucceeded = (json?.failed ?? []).length === 0;
      if (allSucceeded) clear();
      else setFiles([]);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="photo-files">Vyberte fotografie</Label>
        <Input
          ref={fileInputRef}
          id="photo-files"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          onChange={onPick}
        />
      </div>

      {files.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Připraveno k nahrání: {files.length}{" "}
          {files.length === 1 ? "soubor" : files.length < 5 ? "soubory" : "souborů"}.
        </p>
      )}

      {serverError && (
        <p className="text-sm text-destructive" role="alert">
          {serverError}
        </p>
      )}

      {failures.length > 0 && (
        <ul className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <li className="font-medium text-destructive">Některé fotky se nepodařilo nahrát:</li>
          {failures.map((f, i) => (
            <li key={i} className="text-destructive/90">
              · {f.filename}: {f.reason}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={pending || files.length === 0}
          onClick={upload}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <ImagePlus className="size-4" aria-hidden />
          )}
          Nahrát fotky
        </Button>
        {files.length > 0 && !pending && (
          <Button type="button" variant="outline" onClick={clear}>
            <Trash2 className="size-4" aria-hidden /> Zrušit výběr
          </Button>
        )}
      </div>
    </div>
  );
}
