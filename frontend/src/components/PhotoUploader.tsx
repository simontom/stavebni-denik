import { useRef, useState } from "react";
import { czechPlural } from "../lib/czech";
import { checkPhotoFiles } from "../lib/photoFiles";
import type { PhotoUploads } from "../lib/usePhotoUploads";
import { uploadSummary, type UploadEntry } from "../lib/uploadQueue";
import type { PhotoUploaded } from "../lib/photoUpload";
import { Button } from "./ui";

/** What the row of a photo says about where it is. */
function statusText(entry: UploadEntry<PhotoUploaded>): string {
  const percent = Math.round(entry.progress * 100);
  switch (entry.status) {
    case "waiting":
      return "Čeká na řadu";
    case "uploading":
      return percent >= 100 ? "Zpracovává se…" : `${percent} %`;
    case "retrying":
      return `Server je zaneprázdněný, další pokus za ${entry.retryInSeconds ?? 0} s`;
    case "failed":
      return "Nenahráno";
    case "done":
      return "Nahráno";
  }
}

/**
 * Several photos at once (backlog B5): the person chooses any number of files, sees which ones the page would refuse and why (a file that is
 * over 5 MB or is not an image is refused here, before anything is sent: the server checks again), and sends the rest. They go one by one,
 * two requests at a time (`uploadQueue.ts`), each with a bar; "Nahráno 3 z 5" is said politely as they arrive; a photo that fails never holds the
 * others back, and "Zkusit znovu" sends those that may pass the next time. The list is of what is on its way or has failed: a photo that has
 * arrived is in the photographs of the entry above it. Removing a photo is not here (backlog A4 is the owner's decision).
 */
export function PhotoUploader({ uploads, enabled, needsSavedEntry }: { uploads: PhotoUploads; enabled: boolean; needsSavedEntry: boolean }) {
  const { queue, snapshot } = uploads;
  const input = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [refused, setRefused] = useState<{ name: string; message: string }[]>([]);

  const choose = (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = checkPhotoFiles(Array.from(event.target.files ?? []));
    setSelected(checked.accepted);
    setRefused(checked.refused);
  };

  const start = () => {
    if (selected.length === 0 || !enabled) return;
    queue.add(selected);
    setSelected([]);
    setRefused([]);
    // the choice has been taken over: the field is empty again, so the same file can be chosen once more
    if (input.current) input.current.value = "";
  };

  const listed = snapshot.entries.filter((e) => e.status !== "done");
  const canRetry = snapshot.entries.some((e) => e.status === "failed" && e.retryable);

  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="photo-files" className="text-sm font-medium text-ink">
          Fotky k nahrání
        </label>
        <input
          ref={input}
          id="photo-files"
          type="file"
          accept="image/*"
          multiple
          disabled={!enabled}
          aria-describedby={needsSavedEntry ? "photo-files-hint" : undefined}
          onChange={choose}
          className="text-sm text-ink-muted file:mr-4 file:rounded-md file:border-0 file:bg-primary-soft file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary-ink hover:file:bg-neutral-soft"
        />
        <Button disabled={selected.length === 0 || !enabled} onClick={start}>
          Nahrát fotky
        </Button>
        {needsSavedEntry && (
          <span id="photo-files-hint" className="text-xs text-warning-ink">
            Fotky lze přidat po uložení záznamu.
          </span>
        )}
      </div>

      {selected.length > 0 && (
        <p className="text-sm text-ink-muted">
          Vybráno: {selected.length} {czechPlural(selected.length, "fotka", "fotky", "fotek")}
        </p>
      )}
      {refused.length > 0 && (
        <div role="alert" className="rounded-md border-l-4 border-danger bg-danger-soft p-3 text-sm text-danger-ink">
          <p className="font-semibold">{refused.length === 1 ? "Tento soubor se nenahraje:" : "Tyto soubory se nenahrají:"}</p>
          <ul className="mt-1 list-disc pl-5">
            {refused.map((r, i) => (
              <li key={`${r.name}-${i}`}>{r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* What has arrived, said politely (the region is always there, so a change in it is announced) */}
      <p role="status" className="text-sm font-medium text-ink">
        {uploadSummary(snapshot)}
      </p>

      {listed.length > 0 && (
        <ul aria-label="Nahrávané fotky" className="space-y-2">
          {listed.map((entry) => {
            const percent = Math.round(entry.progress * 100);
            return (
              <li key={entry.id} className="rounded-md border border-line p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium text-ink">{entry.name}</span>
                  <span className="shrink-0 text-xs text-ink-muted tabular-nums">{statusText(entry)}</span>
                </div>
                {entry.status !== "failed" && (
                  <div
                    role="progressbar"
                    aria-label={`Nahrávání: ${entry.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-soft"
                  >
                    <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                  </div>
                )}
                {entry.status === "failed" && entry.error && (
                  <p role="alert" className="mt-2 text-sm font-medium text-danger-ink">
                    {entry.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(canRetry || (!snapshot.running && snapshot.total > 0)) && (
        <div className="flex flex-wrap gap-2">
          {canRetry && (
            <Button variant="secondary" onClick={() => queue.retryFailed()}>
              Zkusit znovu
            </Button>
          )}
          {!snapshot.running && snapshot.total > 0 && (
            <Button variant="quiet" onClick={() => queue.clearFinished()}>
              Skrýt přehled
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
