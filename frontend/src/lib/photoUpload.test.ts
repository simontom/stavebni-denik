// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_EXPIRED_EVENT } from "./api";
import { createPhotoSender } from "./photoUpload";

/** An `XMLHttpRequest` that a test answers by hand. */
class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  body: FormData | null = null;
  aborted = false;
  status = 0;
  responseText = "";
  responseHeaders: Record<string, string> = {};
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  answer(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.responseHeaders = headers;
    this.onload?.();
  }
}

const original = globalThis.XMLHttpRequest;
beforeEach(() => {
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
});
afterEach(() => {
  globalThis.XMLHttpRequest = original;
});

const photo = () => new File(["abc"], "strop.jpg", { type: "image/jpeg" });
const send = (signal = new AbortController().signal, onProgress: (f: number) => void = () => {}) =>
  createPhotoSender({ projectId: "proj-1", reportId: "2026-10-01" })(photo(), onProgress, signal);

describe("createPhotoSender: one photo, one request to the upload endpoint", () => {
  it("posts the fields that say where the photo belongs before the file, as the server requires", async () => {
    const result = send();
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/photos/upload");
    expect([...xhr.body!.keys()]).toEqual(["reportId", "projectId", "photo"]);
    expect(xhr.body!.get("reportId")).toBe("2026-10-01");
    expect(xhr.body!.get("projectId")).toBe("proj-1");
    expect((xhr.body!.get("photo") as File).name).toBe("strop.jpg");
    xhr.answer(200, { status: "ok", id: "abc-1", url: "/api/photos/abc-1", name: "strop.jpg" });
    expect(await result).toEqual({ kind: "ok", value: { id: "abc-1", url: "/api/photos/abc-1", name: "strop.jpg" } });
  });

  it("reports how much of the file has gone out", async () => {
    const seen: number[] = [];
    const result = send(undefined, (f) => seen.push(f));
    const xhr = FakeXhr.last;
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 250, total: 1000 });
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 1000, total: 1000 });
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 5, total: 0 }); // no length known: nothing to report
    expect(seen).toEqual([0.25, 1]);
    xhr.answer(200, { id: "x", url: "/api/photos/x", name: "strop.jpg" });
    await result;
  });

  it("calls a busy server by its two answers, with the wait it asked for", async () => {
    const first = send();
    FakeXhr.last.answer(429, { error: "Právě se nahrává další vaše fotografie. Počkejte, až skončí, a zkuste to znovu." }, { "retry-after": "5" });
    expect(await first).toEqual({ kind: "busy", status: 429, message: "Právě se nahrává další vaše fotografie. Počkejte, až skončí, a zkuste to znovu.", retryAfterSeconds: 5 });

    const second = send();
    FakeXhr.last.answer(503, { error: "Server právě přijímá mnoho fotografií, zkuste to za chvíli", code: "UPLOAD_BUSY" }, { "retry-after": "5" });
    expect(await second).toMatchObject({ kind: "busy", status: 503, retryAfterSeconds: 5 });
  });

  it("takes a busy answer without a usable Retry-After as 'no time given', and one without a message as a Czech sentence", async () => {
    const none = send();
    FakeXhr.last.answer(429, "<html>", {});
    expect(await none).toMatchObject({ kind: "busy", retryAfterSeconds: null, message: "Server je právě zaneprázdněný, zkuste to za chvíli." });
    const odd = send();
    FakeXhr.last.answer(429, {}, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
    expect(await odd).toMatchObject({ kind: "busy", retryAfterSeconds: null });
    const zero = send();
    FakeXhr.last.answer(503, {}, { "retry-after": "0" });
    expect(await zero).toMatchObject({ kind: "busy", retryAfterSeconds: null });
  });

  it("gives the refusal of the server in its own words (Czech), and in ours when it has none", async () => {
    const bad = send();
    FakeXhr.last.answer(400, { error: "Soubor není platný obrázek" });
    expect(await bad).toEqual({ kind: "rejected", status: 400, message: "Soubor není platný obrázek" });
    const nothing = send();
    FakeXhr.last.answer(500, "oops");
    expect(await nothing).toEqual({ kind: "rejected", status: 500, message: "Nahrání fotky se nezdařilo (500)." });
    const big = send();
    FakeXhr.last.answer(413, {});
    expect(await big).toEqual({ kind: "rejected", status: 413, message: "Nahrání fotky se nezdařilo (413)." });
  });

  it("raises the same window event as apiFetch when the session is over, and says so", async () => {
    const events: string[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent<{ method: string }>).detail.method);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    try {
      const result = send();
      FakeXhr.last.answer(401, { error: "Přihlášení vypršelo" });
      expect(await result).toEqual({ kind: "expired", message: "Přihlášení vypršelo. Přihlaste se znovu a zkuste to ještě jednou." });
      expect(events).toEqual(["POST"]);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    }
  });

  it("calls a connection that was lost, or an answer that came with a photo that cannot be read, 'lost': it is not known what the server did", async () => {
    const dropped = send();
    FakeXhr.last.onerror!();
    expect(await dropped).toEqual({ kind: "lost" });
    const timedOut = send();
    FakeXhr.last.ontimeout!();
    expect(await timedOut).toEqual({ kind: "lost" });
    // the server said 200 and the answer cannot be read: the photo is stored, but nothing says which
    const garbled = send();
    FakeXhr.last.answer(200, "not json");
    expect(await garbled).toEqual({ kind: "lost" });
    const noId = send();
    FakeXhr.last.answer(200, { status: "ok" });
    expect(await noId).toEqual({ kind: "lost" });
  });

  it("stops the request when the queue says so, and answers 'lost' (the person left)", async () => {
    const controller = new AbortController();
    const result = send(controller.signal);
    const xhr = FakeXhr.last;
    controller.abort();
    expect(xhr.aborted).toBe(true);
    expect(await result).toEqual({ kind: "lost" });
  });

  it("does not send anything when the queue was stopped before the request began", async () => {
    const controller = new AbortController();
    controller.abort();
    FakeXhr.last = undefined as unknown as FakeXhr;
    expect(await send(controller.signal)).toEqual({ kind: "lost" });
    expect(FakeXhr.last?.body ?? null).toBeNull();
  });
});
