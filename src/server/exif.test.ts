import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { parseExifSafely } from "./exif";

/**
 * `parseExifSafely` is the photo-upload metadata extractor. Two things
 * matter:
 *
 *  - On malformed / EXIF-less / empty inputs it must NEVER throw — the
 *    upload pipeline depends on a clean fallback to keep capturedAt /
 *    gps as null.
 *  - When EXIF is present it must produce real, sane values
 *    (DateTimeOriginal → Date, GPS → bounded lat/lon).
 *
 * Fixtures are generated on the fly with sharp's `withExif`, so we don't
 * need to vendor a binary JPEG into the repo.
 */

async function plainJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 0, g: 128, b: 0 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function jpegWithExif(exif: Record<string, Record<string, string>>): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 0, g: 128, b: 0 },
    },
  })
    .withExif(exif)
    .jpeg()
    .toBuffer();
}

describe("parseExifSafely — safety", () => {
  it("returns empty record on an empty buffer", async () => {
    const out = await parseExifSafely(Buffer.alloc(0));
    expect(out).toEqual({ capturedAt: null, gps: null });
  });

  it("returns empty record on garbage bytes", async () => {
    const garbage = Buffer.from("not an image at all\n".repeat(20));
    const out = await parseExifSafely(garbage);
    expect(out).toEqual({ capturedAt: null, gps: null });
  });

  it("returns empty record on a JPEG without EXIF", async () => {
    const out = await parseExifSafely(await plainJpeg());
    expect(out).toEqual({ capturedAt: null, gps: null });
  });
});

describe("parseExifSafely — happy path", () => {
  it("extracts DateTimeOriginal as a Date when present", async () => {
    // Sharp routes DateTimeOriginal into the Exif SubIFD (IFD2).
    const jpeg = await jpegWithExif({
      IFD2: { DateTimeOriginal: "2026:06:15 10:30:00" },
    });
    const out = await parseExifSafely(jpeg);
    expect(out.capturedAt).toBeInstanceOf(Date);
    expect(out.capturedAt?.getFullYear()).toBe(2026);
    expect(out.capturedAt?.getMonth()).toBe(5); // June (0-indexed)
    expect(out.capturedAt?.getDate()).toBe(15);
  });

  it("extracts GPS lat/lon and bounds-checks them", async () => {
    // GPS IFD = IFD3 in sharp; values are degrees/minutes/seconds rational strings.
    const jpeg = await jpegWithExif({
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "49/1 49/1 1560/100",
        GPSLongitudeRef: "E",
        GPSLongitude: "18/1 16/1 3300/100",
      },
    });
    const out = await parseExifSafely(jpeg);
    expect(out.gps).not.toBeNull();
    expect(out.gps!.lat).toBeGreaterThan(49);
    expect(out.gps!.lat).toBeLessThan(50);
    expect(out.gps!.lon).toBeGreaterThan(18);
    expect(out.gps!.lon).toBeLessThan(19);
  });

  it("ignores out-of-range GPS values without throwing", async () => {
    const jpeg = await jpegWithExif({
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "200/1 0/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "400/1 0/1 0/1",
      },
    });
    const out = await parseExifSafely(jpeg);
    expect(out.gps).toBeNull();
  });
});
