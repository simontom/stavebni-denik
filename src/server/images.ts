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

/** Maximum accepted upload size (bytes). 5 MiB pokryje post-resize
 *  JPEG (typicky 300-700 KB, max ~1-2 MB) s 5× rezervou. Klient
 *  resize na 1920 px je primární mechanismus — server byte cap jen
 *  blokuje bypass (curl, raw upload). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Hard ceiling on decoded pixel count for inbound images. Klient
 * VŽDY resize-uje na 1920 px long edge (≈ 1920² = 3.7 MP v nejhorším
 * případě 1:1, typicky 1920×1440 = 2.8 MP). Tento server-side strop
 * 8 MP dává cca 2× rezervu nad post-resize výstupem a tvrdě odmítne:
 *
 *   - raw 12 MP foto z mobilu poslanou přes curl/API (bypass UI),
 *   - 50+ MP HEIC z full-res režimu (overshoot bez resize),
 *   - vícenásobné panorama (kde 1920 × cokoliv ≫ 8 MP).
 *
 * Tj. hlavní zmenšení dělá klient; tady jen safety net.
 */
export const MAX_PIXELS = 8_000_000;

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

// ---------------------------------------------------------------------------
// Magic byte (file-signature) validation
// ---------------------------------------------------------------------------

/**
 * Minimum number of leading bytes we need to inspect in order to
 * identify every accepted format.  HEIF/HEIC needs bytes 4-11,
 * WebP needs bytes 8-11, PNG header is 8 bytes → 12 is enough.
 */
const MAGIC_HEADER_BYTES = 12;

/**
 * Check that `buf` starts with one of the binary signatures of the
 * image formats we accept.  This is intentionally a fast, zero-alloc
 * pre-flight check that runs BEFORE we hand the buffer to sharp's
 * native decoder — it eliminates obvious non-images (EXEs, scripts,
 * PDFs, SVGs, …) cheaply and reduces the attack surface of the C++
 * image parsers.
 *
 * Returns `true` when the buffer looks like a plausible image.
 * Callers MUST still run `sharp().metadata()` for the authoritative
 * format check.
 */
export function hasValidImageSignature(buf: Buffer): boolean {
  if (buf.length < MAGIC_HEADER_BYTES) return false;

  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4E &&
    buf[3] === 0x47 &&
    buf[4] === 0x0D &&
    buf[5] === 0x0A &&
    buf[6] === 0x1A &&
    buf[7] === 0x0A
  ) {
    return true;
  }

  // WebP: RIFF....WEBP  (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP")
  if (
    buf[0] === 0x52 && // R
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x46 && // F
    buf[8] === 0x57 && // W
    buf[9] === 0x45 && // E
    buf[10] === 0x42 && // B
    buf[11] === 0x50   // P
  ) {
    return true;
  }

  // HEIF / HEIC / AVIF: ISO Base Media File Format — "ftyp" box at
  // offset 4 followed by a brand tag. We accept the container
  // signature (ftyp) and let sharp resolve the specific codec.
  if (
    buf[4] === 0x66 && // f
    buf[5] === 0x74 && // t
    buf[6] === 0x79 && // y
    buf[7] === 0x70    // p
  ) {
    return true;
  }

  return false;
}

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

  // Fast pre-flight: inspect the first 12 bytes for a known image
  // file signature. Rejects EXEs, scripts, PDFs, SVGs, etc. before
  // the expensive sharp native decoder is even loaded.
  if (!hasValidImageSignature(input)) {
    throw new InvalidImageError(
      "Soubor nemá platnou hlavičku obrázku (nepodporovaný nebo poškozený formát).",
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
