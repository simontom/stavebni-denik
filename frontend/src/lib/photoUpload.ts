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
  /** Whether the person who uploaded it may remove it (the server says so in `photo.canDelete`: the one who uploads may, until the entry is signed). */
  canDelete: boolean;
}

/** `photo.canDelete` of the answer: only an explicit yes counts (a button that is not offered is safe, one that is refused is not). */
function canDeleteOf(body: object): boolean {
  const photo: unknown = "photo" in body ? body.photo : null;
  return typeof photo === "object" && photo !== null && "canDelete" in photo && photo.canDelete === true;
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

/** The `code` the server sent ({ "code": "UPLOAD_BUSY" }), if the body is that. */
function serverCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string") return parsed.code;
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
      if (signal.aborted) return resolve({ kind: "unsent" });
      const xhr = new XMLHttpRequest();
      // Whether the whole body has gone out (the upload has ended). Only then can the server have a photo: a connection that fails before that
      // leaves it nothing to store, so a second try is safe; one that fails after it may have lost only the answer.
      let bodySent = false;
      const failed = (): SendOutcome<PhotoUploaded> => (bodySent ? { kind: "lost", reason: "connection" } : { kind: "unsent" });
      const stop = () => xhr.abort();
      const settle = (outcome: SendOutcome<PhotoUploaded>) => {
        signal.removeEventListener("abort", stop);
        resolve(outcome);
      };
      xhr.open("POST", "/api/photos/upload");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      };
      xhr.upload.onload = () => {
        bodySent = true;
      };
      xhr.onerror = () => settle(failed());
      xhr.ontimeout = () => settle(failed());
      xhr.onabort = () => settle(failed());
      xhr.onload = () => {
        const status = xhr.status;
        if (status >= 200 && status < 300) {
          // The photo is stored. An answer that cannot be read says nothing of which one it is: not known, like a lost connection.
          try {
            const body: unknown = JSON.parse(xhr.responseText);
            if (body && typeof body === "object" && "id" in body && typeof body.id === "string") {
              const url = "url" in body && typeof body.url === "string" ? body.url : `/api/photos/${body.id}`;
              const name = "name" in body && typeof body.name === "string" ? body.name : file.name;
              return settle({ kind: "ok", value: { id: body.id, url, name, canDelete: canDeleteOf(body) } });
            }
          } catch {
            // fall through
          }
          return settle({ kind: "lost", reason: "gateway" });
        }
        if (status === 401) {
          notifySessionExpired("POST");
          return settle({ kind: "expired", message: SESSION_EXPIRED_MESSAGE });
        }
        const message = serverMessage(xhr.responseText);
        // Busy is what OUR server says: 429, or 503 with a wait or with UPLOAD_BUSY (it took nothing). A 503 that asks for no wait, a 502 and a 504 come
        // from a gateway in front of it, and the photo may be stored all the same: that is not "busy", it is "no answer".
        const retryHeader = xhr.getResponseHeader("Retry-After");
        if (status === 429 || (status === 503 && (retryHeader !== null || serverCode(xhr.responseText) === "UPLOAD_BUSY"))) {
          return settle({ kind: "busy", status, message: message ?? BUSY_MESSAGE, retryAfterSeconds: retryAfterSeconds(retryHeader) });
        }
        if (status === 502 || status === 503 || status === 504) return settle({ kind: "lost", reason: "gateway" });
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
