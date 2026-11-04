import { useRef, useState, useSyncExternalStore } from "react";
import { czechPlural } from "../lib/czech";
import { checkPhotoFiles } from "../lib/photoFiles";
import type { PhotoUploaded } from "../lib/photoUpload";
import { failedPhotosSentence, uploadSummary, type UploadEntry, type UploadQueue } from "../lib/uploadQueue";
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
      return entry.maybeStored ? "Možná nahráno" : "Nenahráno";
    case "done":
      return "Nahráno";
  }
}

/**
 * Several photos at once (backlog B5): the person chooses any number of files, sees which ones the page would refuse and why (a file that is
 * over 5 MB or is not an image is refused here, before anything is sent: the server checks again), and sends the rest. They go one by one,
 * two requests at a time (`uploadQueue.ts`), each with a bar; "Nahráno 3 z 5" is said politely as they arrive. A photo that fails never holds
 * the others back, and stays on the list with what is wrong: "Zkusit znovu" sends it again (or all that may pass), "Zahodit" takes it off the
 * list (nothing is deleted anywhere: it is only not sent). **While a photo is on the list as failed the entry cannot be signed**, which the line
 * above the list says: signing takes this list off the page. A photo that has arrived is in the photographs of the entry above it. Removing a photo
 * that is on the server is not here (backlog A4 is the owner's decision).
 *
 * The component reads the whole state of the queue itself (the progress), so the page that holds it, which reads only a summary, is not drawn again for it.
 */
export function PhotoUploader({ queue, enabled, needsSavedEntry }: { queue: UploadQueue<PhotoUploaded>; enabled: boolean; needsSavedEntry: boolean }) {
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
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
    // The queue holds the files now, with their names: what failed is sent again from the list, without choosing it once more. The field is empty again.
    if (input.current) input.current.value = "";
  };

  const listed = snapshot.entries.filter((e) => e.status !== "done");
  const retryable = snapshot.entries.filter((e) => e.status === "failed" && e.retryable);

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

      {/* Why the entry cannot be signed yet: a failed photo is on the list, and signing would take the list away */}
      {snapshot.failed > 0 && (
        <p id="photos-failed-line" className="text-sm font-medium text-warning-ink">
          {failedPhotosSentence(snapshot.failed)}
        </p>
      )}

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
                {entry.status === "failed" && (
                  <>
                    {entry.error && (
                      <p role="alert" className="mt-2 text-sm font-medium text-danger-ink">
                        {entry.error}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {entry.retryable && (
                        <Button size="sm" variant="secondary" aria-label={`Zkusit znovu nahrát ${entry.name}`} onClick={() => queue.retry(entry.id)}>
                          Zkusit znovu
                        </Button>
                      )}
                      <Button size="sm" variant="quiet" aria-label={`Zahodit ${entry.name}`} onClick={() => queue.discard(entry.id)}>
                        Zahodit
                      </Button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(retryable.length > 1 || (!snapshot.running && snapshot.total > 0 && snapshot.failed === 0)) && (
        <div className="flex flex-wrap gap-2">
          {retryable.length > 1 && (
            <Button variant="secondary" onClick={() => queue.retryFailed()}>
              Zkusit znovu všechny
            </Button>
          )}
          {!snapshot.running && snapshot.total > 0 && snapshot.failed === 0 && (
            <Button variant="quiet" onClick={() => queue.clearFinished()}>
              Skrýt přehled
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
