// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { hasUnsavedWork, unsavedWorkMessage, discardUnsavedWork } from "./unsavedWork";
import type { PhotoUploaded } from "./photoUpload";
import type { SendOutcome, Sender } from "./uploadQueue";
import { PHOTOS_UPLOADING_MESSAGE, usePhotoUploads } from "./usePhotoUploads";

afterEach(() => {
  cleanup();
  discardUnsavedWork();
});

const photo = (name: string) => new File(["x"], name, { type: "image/jpeg" });
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A sender that a test answers by hand, and whose progress it drives. */
function handSender() {
  const calls: { name: string; progress: (fraction: number) => void; answer: (outcome: SendOutcome<PhotoUploaded>) => void }[] = [];
  const send: Sender<PhotoUploaded> = (file, progress) =>
    new Promise((resolve) => {
      calls.push({ name: file.name, progress, answer: resolve });
    });
  return { send, calls };
}

const stored = (name: string): SendOutcome<PhotoUploaded> => ({ kind: "ok", value: { id: `id-${name}`, url: `/api/photos/id-${name}`, name } });

describe("usePhotoUploads: the page reads a summary, not the progress", () => {
  it("does not draw the page again for the progress of a photo, only for what the page shows: that something is going, and how many failed", async () => {
    const s = handSender();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePhotoUploads({ projectId: "p", reportId: "2026-10-01", onPhoto: () => {}, onLost: () => {}, send: s.send });
    });
    act(() => result.current.queue.add([photo("a.jpg"), photo("b.jpg")]));
    await act(flush);
    expect(result.current.summary).toEqual({ running: true, failed: 0, done: 0, total: 2 });
    const before = renders;

    // twenty events of the browser a second for two photos for two seconds: 80 events, and the page is not drawn for any of them
    for (let i = 1; i <= 40; i++) {
      act(() => {
        s.calls[0].progress(i / 40);
        s.calls[1].progress(i / 80);
      });
    }
    expect(renders, "the page was not drawn again for the progress").toBe(before);
    expect(result.current.queue.getSnapshot().entries[0].progress).toBeGreaterThan(0);

    // a photo that arrives is something the page shows
    act(() => s.calls[0].answer(stored("a.jpg")));
    await act(flush);
    expect(result.current.summary).toEqual({ running: true, failed: 0, done: 1, total: 2 });
    expect(renders).toBeGreaterThan(before);
  });

  it("counts as unsaved work only while photos are on their way, with the words of the leave question", async () => {
    const s = handSender();
    const { result } = renderHook(() => usePhotoUploads({ projectId: "p", reportId: "d", onPhoto: () => {}, onLost: () => {}, send: s.send }));
    expect(hasUnsavedWork()).toBe(false);
    act(() => result.current.queue.add([photo("a.jpg")]));
    await act(flush);
    expect(hasUnsavedWork()).toBe(true);
    expect(unsavedWorkMessage()).toBe(PHOTOS_UPLOADING_MESSAGE);
    expect(unsavedWorkMessage()).toContain("Fotky se ještě nahrávají");
    act(() => s.calls[0].answer({ kind: "unsent" }));
    await act(flush);
    expect(result.current.summary).toMatchObject({ running: false, failed: 1 });
    expect(hasUnsavedWork(), "a failed photo is not unsaved work: the person is told, and signing waits").toBe(false);
  });

  it("tells the page of a photo that arrived, and of one that may have", async () => {
    const s = handSender();
    const arrived: string[] = [];
    let lost = 0;
    const { result } = renderHook(() => usePhotoUploads({ projectId: "p", reportId: "d", onPhoto: (p) => arrived.push(p.name), onLost: () => (lost += 1), send: s.send }));
    act(() => result.current.queue.add([photo("a.jpg"), photo("b.jpg")]));
    await act(flush);
    act(() => s.calls[0].answer(stored("a.jpg")));
    act(() => s.calls[1].answer({ kind: "lost", reason: "gateway" }));
    await act(flush);
    expect(arrived).toEqual(["a.jpg"]);
    expect(lost).toBe(1);
  });

  it("stops what is on its way when the page goes away", async () => {
    const s = handSender();
    const { result, unmount } = renderHook(() => usePhotoUploads({ projectId: "p", reportId: "d", onPhoto: () => {}, onLost: () => {}, send: s.send }));
    act(() => result.current.queue.add([photo("a.jpg")]));
    await act(flush);
    const queue = result.current.queue;
    unmount();
    expect(queue.getSnapshot()).toMatchObject({ total: 0, running: false });
  });
});
