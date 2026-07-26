import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_BYTES,
  preparePhotoForUpload,
  PhotoClientPrepareError,
} from "./photo-client";

describe("photo-client unit tests", () => {
  it("has a correct MAX_BATCH_BYTES constant", () => {
    expect(MAX_BATCH_BYTES).toBe(20 * 1024 * 1024);
  });

  it("throws PhotoClientPrepareError when file is empty (size 0)", async () => {
    // In a Node environment under Vitest, we can instantiate standard Web File objects
    const emptyFile = new File([], "empty.jpg", { type: "image/jpeg" });
    await expect(preparePhotoForUpload(emptyFile)).rejects.toThrow(
      "Soubor je prázdný."
    );
    await expect(preparePhotoForUpload(emptyFile)).rejects.toBeInstanceOf(
      PhotoClientPrepareError
    );
  });
});
