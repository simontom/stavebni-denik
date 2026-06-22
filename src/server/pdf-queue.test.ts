import { describe, expect, it } from "vitest";

import {
  acquirePdfSlot,
  getPdfInFlight,
  getPdfQueueDepth,
} from "./pdf";

/**
 * The PDF render queue is a process-wide semaphore — exercised here
 * directly so the integration test (test/integration/pdf.int.test.ts)
 * can stay focused on the actual Playwright render path.
 *
 * The default concurrency on a 1 GB Fly machine is 1. Bumping it to
 * 2 in this test (via the same env knob the production reader uses)
 * would just leak into other unit tests, so instead we drive the
 * `acquirePdfSlot` API and verify the queue invariants with the
 * default singleton.
 */

describe("acquirePdfSlot", () => {
  it("serialises two concurrent renders so only one runs at a time", async () => {
    let release1: () => void = () => undefined;
    let release2: () => void = () => undefined;

    const first = acquirePdfSlot<string>(
      () =>
        new Promise((resolve) => {
          release1 = () => resolve("first");
        }),
    );

    // Give the event loop a chance to enter the first task body.
    await Promise.resolve();
    expect(getPdfInFlight()).toBe(1);

    const second = acquirePdfSlot<string>(
      () =>
        new Promise((resolve) => {
          release2 = () => resolve("second");
        }),
    );

    // The second call must NOT enter its task body yet.
    await Promise.resolve();
    expect(getPdfInFlight()).toBe(1);
    expect(getPdfQueueDepth()).toBe(1);

    release1();
    const firstValue = await first;
    expect(firstValue).toBe("first");

    // Now the second call should be running.
    await Promise.resolve();
    expect(getPdfInFlight()).toBe(1);
    expect(getPdfQueueDepth()).toBe(0);

    release2();
    const secondValue = await second;
    expect(secondValue).toBe("second");

    expect(getPdfInFlight()).toBe(0);
    expect(getPdfQueueDepth()).toBe(0);
  });

  it("releases the slot when the wrapped task throws", async () => {
    await expect(
      acquirePdfSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(getPdfInFlight()).toBe(0);
    expect(getPdfQueueDepth()).toBe(0);
  });
});
