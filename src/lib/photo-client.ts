/**
 * Client-side image preparation helpers used by `PhotoUploader`.
 *
 * Why on the client?
 *   * Phones upload pristine 12 MP JPEGs over LTE — that's ~5 MB per
 *     photo flowing through the Fly machine + sharp every time.
 *     Resizing first cuts bandwidth ~5×, makes the server's sharp
 *     pipeline an order of magnitude cheaper (less RAM, less CPU,
 *     fewer Sharp instances to OOM-kill on the 1 GB box).
 *   * The server still re-runs the full sharp pipeline as a safety
 *     net — `processImage` accepts whatever we send, so a malicious
 *     client cannot smuggle a 50 MP image around the validation.
 *
 * What we do NOT do:
 *   * No transcoding to webp. JPEG is universally supported and
 *     sharp will normalise on the server anyway.
 *   * No client-side cropping or rotation. Sharp's `.rotate()` reads
 *     EXIF orientation, which we forward as a separate metadata
 *     payload (see below) so the server can still orient correctly.
 *
 * Returns the resized blob plus the harvested EXIF (`capturedAt` and
 * `gps`) — the server stores them on the `Photo` row without having
 * to read EXIF off the stripped JPEG we send.
 */

import exifr from "exifr";

/** Long edge in pixels after client-side resize. Matches the server. */
export const CLIENT_RESIZE_MAX_PX = 1920;

/** Quality knob for the JPEG re-encode (0..1). 0.85 is sharp's q=82-ish. */
export const CLIENT_RESIZE_JPEG_QUALITY = 0.85;

/**
 * Maximum total size of ALL resized blobs in one upload batch (bytes).
 * 20 MiB = ~20 post-resize photos (each typically 300–700 KB). Enforced
 * client-side before the multipart POST is dispatched, and mirrored
 * server-side in the upload route.
 */
export const MAX_BATCH_BYTES = 20 * 1024 * 1024;

/**
 * Soft cap on the SOURCE pixel count we are willing to decode in
 * the browser. Klient resize na 1920 px je hlavní bezpečnostní
 * mechanismus — tahle hodnota je horní hranice toho, co browser
 * vůbec zkusí dekódovat do bitmapy a propustit přes canvas resize.
 *
 * 60 MP = ~7700×7700. Pohodlně akceptuje:
 *   - 12 MP default (Pixel, Samsung, iPhone),
 *   - 24 MP iPhone 15/16 Pro default,
 *   - 48 MP iPhone ProRAW full-res,
 *   - 50 MP Pixel 8 Pro full-res.
 *
 * Odmítá jen extrémy (Samsung S24 Ultra 200 MP režim, panoramata
 * 12000×6000) kde by browser snadno OOM-knul na raw bitmapě.
 *
 * POZN.: TO NENÍ totéž co server `MAX_PIXELS`. Server má mnohem
 * tvrdší cap (8 MP) — bere ho na vstup PO klient resize, kde už
 * payload nesmí být víc než ~3.7 MP. 60 MP je `decode budget` na
 * klientovi, 8 MP je `wire payload limit` na serveru.
 */
export const CLIENT_DECODE_MAX_PIXELS = 60_000_000;

export interface PreparedPhoto {
  /** Resized JPEG blob, ready for the multipart upload. */
  blob: Blob;
  /** Filename to use in FormData — original name normalised to `.jpg`. */
  filename: string;
  /** Original input file size for diagnostics. */
  originalBytes: number;
  /** Resized payload size (== blob.size, exposed for the UI summary). */
  resizedBytes: number;
  /** Output dimensions; used to validate against the server limit. */
  width: number;
  height: number;
  capturedAt: Date | null;
  gps: { lat: number; lon: number } | null;
}

export class PhotoClientPrepareError extends Error {
  code = "PhotoClientPrepareError" as const;
}

/**
 * Read the EXIF blob off the ORIGINAL bytes (before we re-encode
 * and lose it). exifr v7 runs in the browser; we only pull the two
 * fields the photo gallery + PDF export actually use.
 */
async function readExifSafely(file: File): Promise<{
  capturedAt: Date | null;
  gps: { lat: number; lon: number } | null;
}> {
  try {
    const parsed = (await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      mergeOutput: true,
      ifd1: false,
      interop: false,
      xmp: false,
      icc: false,
      iptc: false,
      jfif: false,
      ihdr: false,
    })) as Record<string, unknown> | null;
    if (!parsed) return { capturedAt: null, gps: null };

    let capturedAt: Date | null = null;
    const dto = parsed.DateTimeOriginal;
    if (dto instanceof Date && !Number.isNaN(dto.getTime())) capturedAt = dto;
    else if (typeof dto === "string") {
      const iso = dto.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) capturedAt = d;
    }

    const lat = parsed.latitude;
    const lon = parsed.longitude;
    const gps =
      typeof lat === "number" &&
      typeof lon === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
        ? { lat, lon }
        : null;

    return { capturedAt, gps };
  } catch {
    return { capturedAt: null, gps: null };
  }
}

/** Decode the file via the browser's built-in image loader. */
function loadImageBitmap(file: File): Promise<ImageBitmap> {
  // Most browsers support createImageBitmap; the fallback decoding
  // path via <img> is heavier and rarely needed in 2026.
  return createImageBitmap(file);
}

/** "stavba.jpg" / "IMG_1234.HEIC" → "stavba.jpg" / "IMG_1234.jpg". */
function normaliseFilename(input: string): string {
  const noExt = input.replace(/\.[^./\\]+$/, "");
  return `${noExt || "photo"}.jpg`;
}

/**
 * Resize an image to fit within `CLIENT_RESIZE_MAX_PX` on its long
 * edge, re-encode as JPEG, and harvest EXIF (`capturedAt`, `gps`).
 *
 * Throws `PhotoClientPrepareError` for inputs the browser cannot
 * decode or for pixel counts beyond `SERVER_MAX_PIXELS` (the same
 * guard the server enforces — we surface it client-side so the
 * user sees the error before the upload).
 */
export async function preparePhotoForUpload(
  file: File,
): Promise<PreparedPhoto> {
  if (file.size === 0) {
    throw new PhotoClientPrepareError("Soubor je prázdný.");
  }

  const exif = await readExifSafely(file);

  let bitmap: ImageBitmap;
  try {
    bitmap = await loadImageBitmap(file);
  } catch {
    throw new PhotoClientPrepareError(
      "Obrázek se nepodařilo načíst (nepodporovaný formát?).",
    );
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  if (srcW * srcH > CLIENT_DECODE_MAX_PIXELS) {
    bitmap.close();
    throw new PhotoClientPrepareError(
      `Obrázek je příliš velký (${srcW}×${srcH} = ${(srcW * srcH / 1_000_000).toFixed(1)} MP). Maximum je ${CLIENT_DECODE_MAX_PIXELS / 1_000_000} MP — v telefonu vypněte režim plného rozlišení.`,
    );
  }

  // Compute the target size, respecting the long-edge cap WITHOUT
  // ever upscaling — small inputs stay at their original size.
  const longest = Math.max(srcW, srcH);
  const scale =
    longest > CLIENT_RESIZE_MAX_PX ? CLIENT_RESIZE_MAX_PX / longest : 1;
  const targetW = Math.round(srcW * scale);
  const targetH = Math.round(srcH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new PhotoClientPrepareError("Prohlížeč nepodporuje 2D canvas.");
  }
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (b) => resolve(b),
      "image/jpeg",
      CLIENT_RESIZE_JPEG_QUALITY,
    );
  });
  if (!blob) {
    throw new PhotoClientPrepareError(
      "Encoding obrázku do JPEG selhal.",
    );
  }

  return {
    blob,
    filename: normaliseFilename(file.name),
    originalBytes: file.size,
    resizedBytes: blob.size,
    width: targetW,
    height: targetH,
    capturedAt: exif.capturedAt,
    gps: exif.gps,
  };
}
