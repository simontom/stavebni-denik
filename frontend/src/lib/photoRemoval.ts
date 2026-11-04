/**
 * The photos of an entry as the entry page lists them, and the plain logic of removing one (backlog A4), so that the unit tests cover it.
 *
 * Who may remove a photo is **never decided here**: the server says it for every photo (`canDelete`: the manager of the project any photo of an
 * entry that is not signed, a worker the one they uploaded, nobody else, nobody on a signed entry), with the same rule the removal itself
 * applies. The page only shows the button where the answer is yes, and treats a missing answer as no.
 */

/** A photo in the list: [name] is the file's name when this page uploaded it (the server keeps no file names), else the page says "Fotka N". */
export interface PhotoItem {
  id: string;
  url: string;
  name?: string;
  /** The server's answer to "may the person who asks remove this photo now?". */
  canDelete: boolean;
}

/** What the polite status says once a photo is gone. */
export const REMOVED_STATUS = "Fotografie odebrána";

/** The accessible name of a photo's remove button: the photo by its place in the list, as its picture is named ("Fotka 2"). */
export function removeButtonLabel(position: number): string {
  return `Odebrat fotografii ${position}`;
}

/** The `id` of a photo's remove button, so that the focus can be put on the button of the photo that follows. */
export function removeButtonId(photoId: string): string {
  return `remove-photo-${photoId}`;
}

/** The button is offered where the server says the removal would be accepted, and never on a signed entry (the page may know that before the photos do). */
export function showsRemove(photo: PhotoItem, signed: boolean): boolean {
  return !signed && photo.canDelete;
}

/** Where the focus goes when the photo that had it is gone: the button of the next photo that has one, else the heading of the photos. */
export type FocusTarget = { kind: "photo"; id: string } | { kind: "heading" };

export function removalFocusTarget(photos: PhotoItem[], removedId: string, signed: boolean): FocusTarget {
  const at = photos.findIndex((p) => p.id === removedId);
  if (at >= 0) {
    const next = photos.slice(at + 1).find((p) => showsRemove(p, signed));
    if (next) return { kind: "photo", id: next.id };
  }
  return { kind: "heading" };
}

/**
 * The photos the server lists (`photos` of an entry), in its order, keeping the file name of a photo that [known] already holds. A photo that
 * says nothing of the right to remove it, or something that is not a yes, may not be removed: a button that is not offered is safe, one that is
 * refused is not.
 */
export function photosFromServer(serverPhotos: unknown, known: PhotoItem[]): PhotoItem[] {
  if (!Array.isArray(serverPhotos)) return [];
  const items: PhotoItem[] = [];
  for (const raw of serverPhotos as unknown[]) {
    if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string") continue;
    const name = known.find((k) => k.id === raw.id)?.name;
    items.push({ id: raw.id, url: `/api/photos/${raw.id}`, canDelete: "canDelete" in raw && raw.canDelete === true, ...(name ? { name } : {}) });
  }
  return items;
}

/**
 * The photos the server lists, merged into what the page shows (a read that was begun earlier and has just been answered): the server's photos in its
 * order, and after them what the page already shows that the answer lacks (a photo that arrived while the answer was on its way is not lost). A photo
 * that is known to be **gone** ([gone]: removed here, or found missing by a removal) is left out of both, so a read that was begun before its removal
 * cannot bring it back. An answer that is not a list changes nothing.
 */
export function mergeServerPhotos(serverPhotos: unknown, current: PhotoItem[], gone: ReadonlySet<string>): PhotoItem[] {
  if (!Array.isArray(serverPhotos)) return current.filter((c) => !gone.has(c.id));
  const onServer = photosFromServer(serverPhotos, current).filter((p) => !gone.has(p.id));
  return [...onServer, ...current.filter((c) => !gone.has(c.id) && !onServer.some((s) => s.id === c.id))];
}

/** What the person is told when the request to remove a photo got no answer (the connection broke): the photo may be gone all the same. */
export const REMOVAL_NO_ANSWER_MESSAGE = "Spojení se serverem se přerušilo, fotografie se možná neodebrala. Zkuste to znovu; až ji server nenajde, je odebrána.";

/** What [removePhotoOnServer] needs from the page. */
export interface RemovalDeps {
  /** Sends `DELETE /api/photos/{id}`. It rejects with a `TypeError` when the connection failed (as `fetch` does) and with anything else for what the page says as it is (a session that ended). */
  send: (photoId: string) => Promise<Response>;
  /** The photos whose removal got no answer: the server may have removed them. Kept by the page for as long as it shows the entry. */
  noAnswer: Set<string>;
  /** The photos known to be gone from the server (removed here, or found missing by a removal): see [mergeServerPhotos]. Kept like [noAnswer]. */
  gone: Set<string>;
  /** A refusal that means the page was out of date (403, 404, 409): the entry is to be read again. */
  onOutOfDate: () => void;
  /** The message the server sent with a refusal, or the fallback. */
  readError: (res: Response, fallback: string) => Promise<string>;
}

/**
 * What the yes of "Odebrat fotografii?" does. Resolves when the photo is gone; rejects with the words the question says inside itself.
 *
 *  - `204`: gone.
 *  - A **lost connection** is said in words and **remembered for that photo**: the server may have removed it and only its answer been lost. The
 *    question stays open, and the person tries again.
 *  - Then a **`404` for that photo is the answer "removed"**, not a refusal: the second try found nothing because the first had done it. Any other
 *    photo's `404` stays what it is (it is not there, or is not the person's to see): a refusal with the server's words, the entry read again, and
 *    the photo it is about is gone from every later list.
 *  - `403` and `409` stay refusals with the server's words and read the entry again (the right is gone, or the entry was signed meanwhile); the
 *    photo is still there, so it is not gone. Any other failure is the server's words, or the page's own, and says nothing of the entry's state.
 */
export async function removePhotoOnServer(photoId: string, deps: RemovalDeps): Promise<void> {
  let res: Response;
  try {
    res = await deps.send(photoId);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    console.error("Fotografii se nepodařilo odebrat:", err);
    deps.noAnswer.add(photoId);
    throw new Error(REMOVAL_NO_ANSWER_MESSAGE);
  }
  if (res.ok) {
    deps.noAnswer.delete(photoId);
    deps.gone.add(photoId);
    return;
  }
  if (res.status === 404) {
    deps.gone.add(photoId);
    if (deps.noAnswer.delete(photoId)) return;
  }
  if (res.status === 403 || res.status === 404 || res.status === 409) deps.onOutOfDate();
  throw new Error(await deps.readError(res, "Fotografii se nepodařilo odebrat"));
}
