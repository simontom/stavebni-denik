import "server-only";

import sharp from "sharp";

/**
 * Image-processing pipeline for daily-report photos.
 *
 * Goals:
 *  - never persist the user's original (we don't want raw multi-MB
 *    files growing on /data forever and we don't need them as evidence
 *    — the resized JPEG is enough),
 *  - cap the longer edge at 1920 px (more than enough for documenting a
 *    building site; keeps PDF exports small),
 *  - produce a 400 px thumbnail in one pipeline so the gallery on the
 *    report page is fast,
 *  - strip EXIF from the output (we do NOT want GPS leaking into the
 *    file the user can download outside the app). Once we add exifr we
 *    will capture DateTimeOriginal + GPS into the `Photo` columns
 *    BEFORE stripping; for now the columns stay nullable.
 *
 * Everything in this file is pure with respect to the filesystem — it
 * only consumes / produces Buffers. The DATA_DIR write lives in
 * `photo-storage.ts` so this module can be unit-tested without touching
 * disk.
 */

export const MAX_DIMENSION_PX = 1920;
export const THUMB_DIMENSION_PX = 400;
export const MAIN_JPEG_QUALITY = 82;
export const THUMB_JPEG_QUALITY = 75;

/** Maximum accepted upload size (bytes). 20 MiB is plenty for phone JPEGs. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Hard ceiling on decoded pixel count for inbound images. The client
 * is expected to resize 12 MP phone photos to 1920 px (~4 MP) before
 * upload (see `src/lib/photo-client.ts`); this guard rejects anyone
 * trying to bypass that resize and ship a 50 MP raw, which would
 * blow Sharp's heap on the 1 GB Fly machine.
 *
 * 64 MP = 8000×8000 — well above modern phones but a safe envelope
 * for the future.
 */
export const MAX_PIXELS = 64_000_000;

/**
 * MIME types we accept. The browser-reported MIME is not authoritative
 * — `sharp().metadata()` is checked too so a tampered .jpg.exe upload
 * cannot slip through.
 */
export const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Detected formats sharp reports for the inputs we want to accept. */
const ACCEPTED_SHARP_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
  "heif", // covers heic too
  "avif",
]);

export class InvalidImageError extends Error {
  code = "InvalidImage" as const;
}

export class ImageTooLargeError extends Error {
  code = "ImageTooLarge" as const;
}

export interface ProcessedImage {
  main: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

/**
 * Resize + thumbnail an uploaded image. Always returns JPEGs (so the
 * downstream storage layout can assume a single extension) and applies
 * EXIF rotation up-front so a phone-portrait photo doesn't render
 * sideways in the gallery.
 *
 * Throws `InvalidImageError` for anything sharp refuses to decode and
 * `ImageTooLargeError` when the raw payload exceeds MAX_UPLOAD_BYTES
 * (the caller should also enforce this at the HTTP layer).
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length === 0) {
    throw new InvalidImageError("Soubor je prázdný.");
  }
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new ImageTooLargeError(
      `Soubor je větší než ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }

  let format: string | undefined;
  let metaWidth: number | undefined;
  let metaHeight: number | undefined;
  try {
    const meta = await sharp(input).metadata();
    format = meta.format;
    metaWidth = meta.width;
    metaHeight = meta.height;
  } catch {
    throw new InvalidImageError("Soubor není rozpoznán jako obrázek.");
  }
  if (!format || !ACCEPTED_SHARP_FORMATS.has(format)) {
    throw new InvalidImageError(`Nepodporovaný formát obrázku: ${format ?? "neznámý"}.`);
  }
  if (
    metaWidth !== undefined &&
    metaHeight !== undefined &&
    metaWidth * metaHeight > MAX_PIXELS
  ) {
    throw new ImageTooLargeError(
      `Obrázek má příliš velké rozlišení (${metaWidth}×${metaHeight} = ${(metaWidth * metaHeight / 1_000_000).toFixed(1)} MP). Maximum je ${MAX_PIXELS / 1_000_000} MP — upravte rozlišení v telefonu.`,
    );
  }

  // Rotate first so resize is based on the visually correct orientation,
  // then strip EXIF (`withMetadata()` is NOT called) and emit JPEG.
  const mainPipeline = sharp(input)
    .rotate()
    .resize({
      width: MAX_DIMENSION_PX,
      height: MAX_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: MAIN_JPEG_QUALITY, progressive: true, mozjpeg: true });

  const thumbPipeline = sharp(input)
    .rotate()
    .resize({
      width: THUMB_DIMENSION_PX,
      height: THUMB_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_JPEG_QUALITY, progressive: true, mozjpeg: true });

  // `resolveWithObject` is the only way to get the OUTPUT dimensions —
  // sharp's `.metadata()` only describes the input.
  const [mainResult, thumb] = await Promise.all([
    mainPipeline.toBuffer({ resolveWithObject: true }),
    thumbPipeline.toBuffer(),
  ]);

  return {
    main: mainResult.data,
    thumb,
    width: mainResult.info.width,
    height: mainResult.info.height,
  };
}
