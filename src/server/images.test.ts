import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  ACCEPTED_MIME_TYPES,
  ImageTooLargeError,
  InvalidImageError,
  MAX_UPLOAD_BYTES,
  MAX_DIMENSION_PX,
  THUMB_DIMENSION_PX,
  processImage,
} from "./images";

/**
 * `images.ts` is the sharp pipeline for daily-report photos. We
 * unit-test the pure behaviour (resize, format, error mapping) with
 * buffers generated on the fly — no real files needed.
 *
 * Key invariants:
 *  - Garbage input throws InvalidImageError so the API responds 422
 *    instead of crashing the route handler.
 *  - An over-size payload is rejected *before* sharp is invoked.
 *  - Both variants always come back as JPEG with the longer edge capped
 *    at the configured limit.
 *  - Small images are NEVER upscaled (`withoutEnlargement: true`).
 */

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg()
    .toBuffer();
}

describe("processImage — happy path", () => {
  it("resizes a 3000×2000 photo to fit within 1920 px and emits a thumb", async () => {
    const input = await makeJpeg(3000, 2000);
    const out = await processImage(input);

    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(MAX_DIMENSION_PX);
    expect(out.width).toBe(MAX_DIMENSION_PX);
    expect(out.height).toBe(Math.round((2000 / 3000) * MAX_DIMENSION_PX));

    const thumbMeta = await sharp(out.thumb).metadata();
    expect(thumbMeta.format).toBe("jpeg");
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(
      THUMB_DIMENSION_PX,
    );

    const mainMeta = await sharp(out.main).metadata();
    expect(mainMeta.format).toBe("jpeg");
  });

  it("does not upscale images already smaller than the limits", async () => {
    const input = await makeJpeg(800, 600);
    const out = await processImage(input);
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);

    const thumbMeta = await sharp(out.thumb).metadata();
    // Thumb resize is capped at THUMB_DIMENSION_PX and likewise honours
    // `withoutEnlargement` so a 800-wide source produces a 400-wide thumb
    // (the longer edge), not an upscaled 800 px image.
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(
      THUMB_DIMENSION_PX,
    );
  });

  it("accepts the MIME types the API advertises", () => {
    expect(ACCEPTED_MIME_TYPES.has("image/jpeg")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("image/png")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("image/webp")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("image/heic")).toBe(true);
  });
});

describe("processImage — failures", () => {
  it("throws InvalidImageError on an empty buffer", async () => {
    await expect(processImage(Buffer.alloc(0))).rejects.toBeInstanceOf(
      InvalidImageError,
    );
  });

  it("throws InvalidImageError on garbage bytes", async () => {
    const garbage = Buffer.from("this is definitely not an image\n".repeat(50));
    await expect(processImage(garbage)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("throws ImageTooLargeError on a payload bigger than MAX_UPLOAD_BYTES", async () => {
    // We don't need a real image here — the size check runs first.
    const oversize = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    await expect(processImage(oversize)).rejects.toBeInstanceOf(
      ImageTooLargeError,
    );
  });

  it("throws ImageTooLargeError on a decoded image past MAX_PIXELS", async () => {
    // 4000×3000 = 12 MP, nad 8 MP cap. Sharp PNG enkodér produkuje
    // malý soubor (jednolitá barva) takže byte-size guard nezáleží
    // — kontrolujeme metadata pixel-count check.
    const tooManyPixels = await sharp({
      create: {
        width: 4000,
        height: 3000,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(tooManyPixels.length).toBeLessThan(MAX_UPLOAD_BYTES);
    await expect(processImage(tooManyPixels)).rejects.toBeInstanceOf(
      ImageTooLargeError,
    );
  });
});
