import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, checkPhotoFile, checkPhotoFiles, formatMegabytes } from "./photoFiles";

const file = (name: string, size: number, type = "image/jpeg") => ({ name, size, type });

describe("formatMegabytes", () => {
  it("writes a size in megabytes with a decimal comma, as Czech does", () => {
    expect(formatMegabytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatMegabytes(7.3 * 1024 * 1024)).toBe("7,3 MB");
    expect(formatMegabytes(12 * 1024 * 1024 + 1)).toBe("12 MB");
    expect(formatMegabytes(0.04 * 1024 * 1024)).toBe("0,04 MB");
  });
});

describe("checkPhotoFile (the server enforces the same limits; this only spares the person a long upload that is refused)", () => {
  it("accepts an image up to the size the server takes: 5 MiB exactly", () => {
    expect(MAX_PHOTO_BYTES).toBe(5 * 1024 * 1024);
    expect(checkPhotoFile(file("a.jpg", MAX_PHOTO_BYTES))).toBeNull();
    expect(checkPhotoFile(file("a.png", 1, "image/png"))).toBeNull();
  });

  it("refuses an image that is one byte over (without a size that would read as the limit), and says how big a bigger one is", () => {
    expect(checkPhotoFile(file("velka.jpg", MAX_PHOTO_BYTES + 1))).toBe("Soubor „velka.jpg“ je větší než 5 MB.");
    expect(checkPhotoFile(file("velka.jpg", 7.3 * 1024 * 1024))).toBe("Soubor „velka.jpg“ je větší než 5 MB (má 7,3 MB).");
  });

  it("refuses what is not an image", () => {
    expect(checkPhotoFile(file("plan.pdf", 1000, "application/pdf"))).toBe("Soubor „plan.pdf“ není obrázek.");
    expect(checkPhotoFile(file("note.txt", 10, "text/plain"))).toBe("Soubor „note.txt“ není obrázek.");
  });

  it("refuses an empty file", () => {
    expect(checkPhotoFile(file("prazdny.jpg", 0))).toBe("Soubor „prazdny.jpg“ je prázdný.");
  });

  it("leaves a file of unknown type to the server, which reads the bytes (some phones give no type)", () => {
    expect(checkPhotoFile(file("IMG_0001", 1000, ""))).toBeNull();
  });

  it("shortens a very long name in the message", () => {
    const message = checkPhotoFile(file(`${"x".repeat(200)}.pdf`, 1000, "application/pdf"))!;
    expect(message.length).toBeLessThan(120);
    expect(message).toContain("…");
    expect(message.endsWith("není obrázek.")).toBe(true);
  });
});

describe("checkPhotoFiles", () => {
  it("separates the files that can be sent from those that are refused, in the order they were chosen", () => {
    const good1 = file("a.jpg", 100);
    const bad = file("b.pdf", 100, "application/pdf");
    const good2 = file("c.jpg", 200);
    const big = file("d.jpg", MAX_PHOTO_BYTES + 5);
    const { accepted, refused } = checkPhotoFiles([good1, bad, good2, big]);
    expect(accepted).toEqual([good1, good2]);
    expect(refused.map((r) => r.name)).toEqual(["b.pdf", "d.jpg"]);
    expect(refused.map((r) => r.message)).toEqual(["Soubor „b.pdf“ není obrázek.", expect.stringContaining("je větší než 5 MB")]);
  });

  it("is empty for nothing", () => {
    expect(checkPhotoFiles([])).toEqual({ accepted: [], refused: [] });
  });
});
