/**
 * What the page checks about a photo before it sends it. The server checks everything again (magic bytes, header-checked dimensions,
 * re-encoding: PROJECT.md, "Request and upload limits") and its answer is the one that counts; this only spares the person a
 * long upload over a mobile network that would be refused at its end, and says what is wrong in words before anything is sent.
 */

/** The largest photo the server takes: 5 MiB (`UploadLimits`). */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** The part of a `File` this module reads (a test passes plain objects). */
export interface PhotoFileInfo {
  name: string;
  size: number;
  type: string;
}

const MEBIBYTE = 1024 * 1024;

/** A size in megabytes with a decimal comma and no zeros at the end: `7,3 MB`, `5 MB`, `0,04 MB`. */
export function formatMegabytes(bytes: number): string {
  const rounded = Math.round((bytes / MEBIBYTE) * 100) / 100;
  return `${String(rounded).replace(".", ",")} MB`;
}

/** The name in a message: a name of 200 letters would push the sentence off a phone's screen. */
function shortName(name: string): string {
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/** What is wrong with a file that is to be sent as a photo, in a Czech sentence; null when it can be sent. */
export function checkPhotoFile(file: PhotoFileInfo): string | null {
  const name = `Soubor „${shortName(file.name)}“`;
  // A phone may give a file no type at all; the server reads the bytes and decides.
  if (file.type !== "" && !file.type.startsWith("image/")) return `${name} není obrázek.`;
  if (file.size === 0) return `${name} je prázdný.`;
  if (file.size > MAX_PHOTO_BYTES) {
    const limit = formatMegabytes(MAX_PHOTO_BYTES);
    // The size is said only when it reads as bigger than the limit (a file one byte over would say "5 MB" twice).
    const shown = Math.round((file.size / MEBIBYTE) * 100) / 100 > MAX_PHOTO_BYTES / MEBIBYTE + 0.04 ? ` (má ${formatMegabytes(file.size)})` : "";
    return `${name} je větší než ${limit}${shown}.`;
  }
  return null;
}

export interface CheckedPhotos<F extends PhotoFileInfo> {
  accepted: F[];
  refused: { name: string; message: string }[];
}

/** Splits a choice of files into those that can be sent and those that are refused (with the reason), in the order they were chosen. */
export function checkPhotoFiles<F extends PhotoFileInfo>(files: readonly F[]): CheckedPhotos<F> {
  const accepted: F[] = [];
  const refused: { name: string; message: string }[] = [];
  for (const file of files) {
    const problem = checkPhotoFile(file);
    if (problem === null) accepted.push(file);
    else refused.push({ name: file.name, message: problem });
  }
  return { accepted, refused };
}
