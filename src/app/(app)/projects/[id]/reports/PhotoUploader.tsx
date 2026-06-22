"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Camera, ImagePlus, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  PhotoClientPrepareError,
  preparePhotoForUpload,
  type PreparedPhoto,
} from "@/lib/photo-client";

// Client-only — banner reads localStorage at mount. Rendering it on
// the server with a default snapshot and then hydrating with a
// different value (when user previously dismissed / expanded) trips
// React 19's strict hydration mismatch detector. Disable SSR for
// this widget — the report page is already an SSR boundary, FOC of
// the small banner is acceptable UX trade-off.
const PhotoGuidance = dynamic(
  () => import("./PhotoGuidance").then((mod) => mod.PhotoGuidance),
  { ssr: false },
);

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
 * Multi-file photo uploader. Two entry points:
 *   * a regular `<input type="file" multiple>` so the user can pick
 *     several photos from the gallery / file system at once,
 *   * a phone-friendly "Pořídit foto" button that triggers a hidden
 *     `<input type="file" capture="environment">` so tapping it on a
 *     phone opens the rear camera directly. On desktop the button
 *     still works (file picker fallback when no camera is wired up).
 *
 * Both feed the same selected-files state and POST to
 * `/api/photos/upload` as multipart/form-data; on success calls
 * `router.refresh()` so the freshly created photos appear in the
 * gallery without a full page reload. Reports per-file errors inline
 * (image format unsupported, file too big, …) without dropping the
 * successful uploads.
 */
export function PhotoUploader({ reportId }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [failures, setFailures] = useState<UploadFailure[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    if (list.length === 0) return;
    // Merge any camera-captured frame with the file-picker selection so
    // a user can tap the camera, then tap "Vybrat z galerie", and we
    // keep both. New entries dedupe by name+size+lastModified.
    setFiles((prev) => mergeFiles(prev, list));
    setFailures([]);
    setServerError(null);
  }

  function clear() {
    setFiles([]);
    setFailures([]);
    setServerError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
  }

  function upload() {
    if (files.length === 0) return;
    setFailures([]);
    setServerError(null);

    startTransition(async () => {
      const form = new FormData();
      form.append("reportId", reportId);
      const clientFailures: UploadFailure[] = [];
      let attached = 0;
      let originalBytes = 0;
      let resizedBytes = 0;

      // Resize + EXIF-harvest each file on the client BEFORE we put
      // it in the multipart payload. Saves bandwidth and lets the
      // server skip the heavy sharp pipeline branch on the happy
      // path. If a single file fails we keep the rest.
      for (const file of files) {
        try {
          const prepared: PreparedPhoto = await preparePhotoForUpload(file);
          attached += 1;
          originalBytes += prepared.originalBytes;
          resizedBytes += prepared.resizedBytes;

          form.append(
            "files",
            new File([prepared.blob], prepared.filename, {
              type: "image/jpeg",
            }),
          );
          // Per-file metadata sidecar: index-aligned with the
          // `files[]` entries so the server can match them up.
          form.append(
            "filenames",
            prepared.filename,
          );
          form.append(
            "capturedAt",
            prepared.capturedAt ? prepared.capturedAt.toISOString() : "",
          );
          form.append(
            "gps",
            prepared.gps ? JSON.stringify(prepared.gps) : "",
          );
        } catch (err) {
          clientFailures.push({
            filename: file.name,
            reason:
              err instanceof PhotoClientPrepareError
                ? err.message
                : "Předzpracování v prohlížeči selhalo.",
          });
        }
      }

      if (attached === 0) {
        setFailures(clientFailures);
        setServerError(
          clientFailures.length > 0
            ? "Žádný soubor neprošel předzpracováním."
            : "Nebyl vybrán žádný soubor.",
        );
        return;
      }

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
        setFailures(clientFailures);
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
        if (json?.failed) {
          setFailures([...clientFailures, ...json.failed]);
        } else if (clientFailures.length > 0) {
          setFailures(clientFailures);
        }
        return;
      }

      const serverFailures = json?.failed ?? [];
      const allFailures = [...clientFailures, ...serverFailures];
      if (allFailures.length > 0) setFailures(allFailures);

      // Soft diagnostic — we don't surface bandwidth savings in the
      // UI but log them in the console for the curious.
      if (originalBytes > 0) {
        console.info(
          `[photo-uploader] resized ${attached} file(s): ${(originalBytes / 1024 / 1024).toFixed(2)} MB → ${(resizedBytes / 1024 / 1024).toFixed(2)} MB`,
        );
      }

      if (allFailures.length === 0) clear();
      else setFiles([]);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <PhotoGuidance />
      <div className="grid gap-1.5">
        <Label htmlFor="photo-files">Vyberte fotografie</Label>
        {/* Use a native <input type="file"> instead of the shadcn
            wrapper. Base UI's <Input> proxies value/onChange in a way
            that swallows file-input changes on mobile (iOS Safari +
            Android Chrome) — user picks a photo but the React
            `onChange` never fires, so files state stays empty and the
            "Nahrát" button is permanently disabled. Native <input>
            sidesteps the wrapper entirely. Tailwind classes mirror
            shadcn Input's look for visual consistency. */}
        <input
          ref={fileInputRef}
          id="photo-files"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          onChange={onPick}
          className="block w-full cursor-pointer rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none transition-colors file:mr-3 file:inline-flex file:h-6 file:cursor-pointer file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
        />
        {/* Phone-only: a hidden input with capture="environment" so
            "Pořídit foto" jumps straight to the rear camera. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          onChange={onPick}
          className="hidden"
          aria-hidden
          tabIndex={-1}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => cameraInputRef.current?.click()}
          className="self-start sm:hidden"
        >
          <Camera className="size-4" aria-hidden /> Pořídit foto
        </Button>
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

/** Dedupe by name+size+lastModified so re-picking the same shot doesn't double-upload. */
function mergeFiles(prev: File[], incoming: File[]): File[] {
  const keyOf = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
  const seen = new Set(prev.map(keyOf));
  const merged = [...prev];
  for (const f of incoming) {
    const k = keyOf(f);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(f);
    }
  }
  return merged;
}
