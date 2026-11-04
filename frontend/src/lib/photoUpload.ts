/**
 * Sends one photo to `POST /api/photos/upload` with `XMLHttpRequest`, because only that reports how much of a request has gone out
 * (`fetch` cannot, without a streamed body that Safari does not take). It stands in for `apiFetch` and keeps its rules: the request is
 * same-origin with the session cookie and the browser's own `Sec-Fetch-Site` (the cross-site check of the server needs nothing else),
 * and a `401` raises the same window event, so the session dialog signs the person in again in place (`notifySessionExpired`).
 *
 * It never rejects: every way a request can end is an outcome the queue knows (`uploadQueue.ts`).
 */
import { SESSION_EXPIRED_MESSAGE, notifySessionExpired } from "./api";
import type { SendOutcome, Sender } from "./uploadQueue";

/** What the server says of a photo it took (`PhotoUploadResponse`): the page shows it in the list of photos at once. */
export interface PhotoUploaded {
  id: string;
  url: string;
  name: string;
}

const BUSY_MESSAGE = "Server je právě zaneprázdněný, zkuste to za chvíli.";

/** The `error` the server sent ({ "error": "..." }), if the body is that. */
function serverMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" && parsed.error !== "") return parsed.error;
  } catch {
    // not JSON
  }
  return null;
}

/** `Retry-After` in seconds (the server sends a whole number); anything else, and 0, is "no time given". */
function retryAfterSeconds(header: string | null): number | null {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return null;
  const seconds = Number(header.trim());
  return seconds > 0 ? seconds : null;
}

export function createPhotoSender(target: { projectId: string; reportId: string }): Sender<PhotoUploaded> {
  return (file, onProgress, signal) =>
    new Promise<SendOutcome<PhotoUploaded>>((resolve) => {
      if (signal.aborted) return resolve({ kind: "lost" });
      const xhr = new XMLHttpRequest();
      const stop = () => xhr.abort();
      const settle = (outcome: SendOutcome<PhotoUploaded>) => {
        signal.removeEventListener("abort", stop);
        resolve(outcome);
      };
      xhr.open("POST", "/api/photos/upload");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      };
      xhr.onerror = () => settle({ kind: "lost" });
      xhr.ontimeout = () => settle({ kind: "lost" });
      xhr.onabort = () => settle({ kind: "lost" });
      xhr.onload = () => {
        const status = xhr.status;
        if (status >= 200 && status < 300) {
          // The photo is stored. An answer that cannot be read says nothing of which one it is: not known, like a lost connection.
          try {
            const body: unknown = JSON.parse(xhr.responseText);
            if (body && typeof body === "object" && "id" in body && typeof body.id === "string") {
              const url = "url" in body && typeof body.url === "string" ? body.url : `/api/photos/${body.id}`;
              const name = "name" in body && typeof body.name === "string" ? body.name : file.name;
              return settle({ kind: "ok", value: { id: body.id, url, name } });
            }
          } catch {
            // fall through
          }
          return settle({ kind: "lost" });
        }
        if (status === 401) {
          notifySessionExpired("POST");
          return settle({ kind: "expired", message: SESSION_EXPIRED_MESSAGE });
        }
        const message = serverMessage(xhr.responseText);
        if (status === 429 || status === 503) {
          return settle({ kind: "busy", status, message: message ?? BUSY_MESSAGE, retryAfterSeconds: retryAfterSeconds(xhr.getResponseHeader("Retry-After")) });
        }
        settle({ kind: "rejected", status, message: message ?? `Nahrání fotky se nezdařilo (${status}).` });
      };
      // The fields that say where the photo belongs come before the file, so the server knows before it reads the file.
      const form = new FormData();
      form.append("reportId", target.reportId);
      form.append("projectId", target.projectId);
      form.append("photo", file);
      signal.addEventListener("abort", stop, { once: true });
      xhr.send(form);
    });
}
