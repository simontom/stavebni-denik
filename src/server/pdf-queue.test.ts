import { describe, expect, it } from "vitest";

import { acquirePdfSlot, getPdfInFlight, getPdfQueueDepth } from "./pdf";

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

  it("evicts a queued waiter when its AbortSignal fires", async () => {
    let release1: () => void = () => undefined;

    // First slot occupies the only slot.
    const first = acquirePdfSlot<string>(
      () =>
        new Promise((resolve) => {
          release1 = () => resolve("first");
        }),
    );
    await Promise.resolve();
    expect(getPdfInFlight()).toBe(1);

    // Second caller queues with an AbortController.
    const ac = new AbortController();
    const second = acquirePdfSlot<string>(() => Promise.resolve("second"), ac.signal);
    await Promise.resolve();
    expect(getPdfQueueDepth()).toBe(1);

    // Abort the second caller — it should be evicted from the queue.
    ac.abort();
    await expect(second).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === "AbortError",
    );
    expect(getPdfQueueDepth()).toBe(0);

    // The first caller still finishes normally.
    release1();
    await expect(first).resolves.toBe("first");
    expect(getPdfInFlight()).toBe(0);
  });

  it("rejects immediately when signal is already aborted before queuing", async () => {
    let release1: () => void = () => undefined;

    const first = acquirePdfSlot<string>(
      () =>
        new Promise((resolve) => {
          release1 = () => resolve("first");
        }),
    );
    await Promise.resolve();

    const ac = new AbortController();
    ac.abort(); // already aborted before calling acquirePdfSlot

    const second = acquirePdfSlot<string>(() => Promise.resolve("second"), ac.signal);

    await expect(second).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === "AbortError",
    );
    expect(getPdfQueueDepth()).toBe(0);

    release1();
    await first;
    expect(getPdfInFlight()).toBe(0);
  });

  it("does not deadlock when an aborted waiter is dequeued ahead of a healthy one", async () => {
    // Regression: if throwIfAborted() fired before inFlight was
    // incremented, the finally block never ran and the next waiter
    // (C) was never woken — queue stalled permanently.
    let release1: () => void = () => undefined;

    const first = acquirePdfSlot<string>(
      () =>
        new Promise((resolve) => {
          release1 = () => resolve("first");
        }),
    );
    await Promise.resolve();

    // B queues with a signal we will abort while it is waiting.
    const acB = new AbortController();
    const second = acquirePdfSlot<string>(() => Promise.resolve("second"), acB.signal);
    await Promise.resolve();
    expect(getPdfQueueDepth()).toBe(1);

    // C queues without a signal — should still run after B is evicted.
    const third = acquirePdfSlot<string>(() => Promise.resolve("third"));
    await Promise.resolve();
    expect(getPdfQueueDepth()).toBe(2);

    // Abort B while it is still queued (clean eviction path).
    acB.abort();
    await expect(second).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === "AbortError",
    );
    expect(getPdfQueueDepth()).toBe(1); // C is still waiting

    // Release first → C should be dequeued and run.
    release1();
    await expect(first).resolves.toBe("first");

    const thirdValue = await third;
    expect(thirdValue).toBe("third");
    expect(getPdfInFlight()).toBe(0);
    expect(getPdfQueueDepth()).toBe(0);
  });
});
