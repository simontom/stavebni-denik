import "server-only";

import exifr from "exifr";

/**
 * Best-effort EXIF reader for daily-report photos.
 *
 * We only persist two bits of EXIF data with the photo row:
 *  - DateTimeOriginal → `Photo.capturedAt`, so the gallery can later
 *    sort by capture time and the PDF export can show when the picture
 *    was actually taken (not just when it was uploaded).
 *  - GPS latitude/longitude → `Photo.gps`, useful when reviewing photos
 *    from a project that spans a larger area.
 *
 * Everything else from EXIF is intentionally dropped: we re-emit the
 * JPEG in `images.ts` with EXIF stripped so the file the user downloads
 * doesn't leak metadata.
 *
 * The function NEVER throws: malformed EXIF, garbage input, or files
 * without EXIF all collapse to `{ capturedAt: null, gps: null }` so an
 * upload of e.g. a screenshot doesn't break the pipeline.
 */

export interface PhotoExif {
  capturedAt: Date | null;
  gps: { lat: number; lon: number } | null;
}

const EMPTY: PhotoExif = { capturedAt: null, gps: null };

/** Convert an exifr DateTimeOriginal value into a valid Date or null. */
function coerceCapturedAt(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string") {
    // EXIF stores timestamps as "YYYY:MM:DD HH:MM:SS" (colon separators in
    // the date portion); the ISO parser doesn't accept that natively.
    const iso = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Sanitize lat/lon into the WGS84 valid range. */
function coerceGps(rec: Record<string, unknown>): PhotoExif["gps"] {
  const lat = rec.latitude;
  const lon = rec.longitude;
  if (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  ) {
    return { lat, lon };
  }
  return null;
}

/**
 * Parse `capturedAt` + `gps` from a photo buffer. Returns an "empty"
 * record (both fields null) on any failure or missing data — never
 * throws.
 */
export async function parseExifSafely(input: Buffer): Promise<PhotoExif> {
  if (input.length === 0) return EMPTY;
  let parsed: unknown;
  try {
    parsed = await exifr.parse(input, {
      tiff: true,
      exif: true,
      gps: true,
      mergeOutput: true,
      // We don't need any of these and parsing them costs time:
      ifd1: false,
      interop: false,
      xmp: false,
      icc: false,
      iptc: false,
      jfif: false,
      ihdr: false,
    });
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== "object") return EMPTY;
  const rec = parsed as Record<string, unknown>;
  return {
    capturedAt: coerceCapturedAt(rec.DateTimeOriginal),
    gps: coerceGps(rec),
  };
}
