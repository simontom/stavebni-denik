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
