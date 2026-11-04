/**
 * The queue behind "several photos at once" (backlog B5), as plain logic so the unit tests cover it (the browser parts are
 * `photoUpload.ts` and `usePhotoUploads.ts`). Photos go one per request, at most two requests at a time: the server lets a person
 * have two uploads in flight and answers a third with `429` (PROJECT.md, "Request and upload limits"), and takes 60 uploads in 5 minutes.
 *
 * What each ending of a request makes of a photo:
 *  - stored: done;
 *  - `429` or `503` with a wait (busy; the server did not take the photo): wait as long as `Retry-After` says (never less, up to 30 % more so that two
 *    tabs do not come back together, half as long again at every try; 5 s, 10 s, 20 s, give or take 30 %, when it says nothing) and send the same photo
 *    again, four tries at most. A wait over `maxAutoWaitSeconds` is not waited for with the page open: the photo fails at once and says when to try
 *    again. The photo keeps its place while it waits, so two at a time still holds;
 *  - any other refusal (`4xx`): failed, and sending it again would be refused again. Not `408` (the server took nothing: it waited too long for the
 *    file) and not `5xx` (it may pass the next time): those are offered again ("Zkusit znovu") and never sent by themselves;
 *  - **the body had gone out and no answer came** (a lost connection after it, a gateway that did not answer): failed, **never sent again by itself**.
 *    The photo may have arrived, a photo cannot be taken off an entry (backlog A4 is the owner's decision), and a second copy would stay for good: the
 *    page is told (`onLost`) so that it shows the photos as they are on the server, and the person looks and decides. Only that photo is marked so;
 *  - the connection failed **before the body had gone out**: nothing arrived, the photo is failed and plainly not sent ("Zkusit znovu" is safe);
 *  - the session ended (`401`): this photo and every one that waits fail with the same words and nothing more is sent until the person asks.
 * A photo that fails never holds the others back.
 */
import { czechPlural } from "./czech";

export type SendOutcome<V> =
  | { kind: "ok"; value: V }
  /** `429`, or `503` with a wait: the server turned the photo away before it took it, so sending it again is safe. */
  | { kind: "busy"; status: number; message: string; retryAfterSeconds: number | null }
  /** The server refused the photo (any other status): [status] 408 and 5xx may pass the next time. */
  | { kind: "rejected"; status: number; message: string }
  /** The body had gone out and no (usable) answer came: a lost connection after it, or a gateway that did not answer: it is not known whether the photo arrived. */
  | { kind: "lost"; reason?: "connection" | "gateway" }
  /** The connection failed before the body had gone out: the server took nothing. */
  | { kind: "unsent" }
  /** `401`: the session is over. */
  | { kind: "expired"; message: string };

/** Sends one file (one request); [onProgress] gets the part of it that has gone out, 0 to 1. Resolves, never rejects. */
export type Sender<V> = (file: File, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<SendOutcome<V>>;

export type UploadStatus = "waiting" | "uploading" | "retrying" | "done" | "failed";

export interface UploadEntry<V> {
  id: number;
  name: string;
  size: number;
  status: UploadStatus;
  /** The part of the file that has gone out in the try that is on its way, 0 to 1 (1 when it is done). */
  progress: number;
  /** How many times it has been sent. */
  attempt: number;
  /** While it is `retrying`: how many seconds it was told to wait. */
  retryInSeconds: number | null;
  /** Why it failed, in Czech. */
  error: string | null;
  /** "Zkusit znovu" can send it again: false for what the server refused and would refuse again. */
  retryable: boolean;
  /** Failed, and the photo may be on the server all the same (its body had gone out): a second try may make a copy. */
  maybeStored: boolean;
  /** What the server answered when it took the photo. */
  value: V | null;
}

export interface UploadSnapshot<V> {
  entries: readonly UploadEntry<V>[];
  total: number;
  done: number;
  failed: number;
  /** Something waits, is on its way or waits for a second try. */
  running: boolean;
}

/** What a page that does not draw the list needs to know: it changes only when one of these does, never for progress. */
export interface UploadSummary {
  running: boolean;
  failed: number;
  done: number;
  total: number;
}

export interface QueueHandlers<V> {
  /** A photo arrived (called once for each, in the order they arrive). */
  onDone?: (entry: UploadEntry<V>, value: V) => void;
  /** A photo whose body had gone out got no answer: it may be on the server, and the page should look at what the entry has. */
  onLost?: () => void;
}

export interface QueueOptions<V> extends QueueHandlers<V> {
  /** Requests at a time (2: what the server allows a person). */
  concurrency?: number;
  /** Times a photo is sent when the server is busy, the first one included. */
  maxAttempts?: number;
  /** The longest wait that is waited for with the page open; a `Retry-After` over it fails the photo at once. */
  maxAutoWaitSeconds?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** A random number from 0 to 1 for the jitter of the waits (a test gives a number). */
  random?: () => number;
  /** The time in milliseconds, for how often progress is told (a test gives a clock). */
  now?: () => number;
}

export const LOST_MESSAGE = "Spojení se přerušilo, až když se fotka odeslala. Fotka se možná nahrála: podívejte se, jestli je mezi fotkami, než ji pošlete znovu.";
export const GATEWAY_MESSAGE = "Server neodpověděl, jak má. Fotka se mohla uložit: podívejte se, jestli je mezi fotkami, než ji pošlete znovu.";
export const UNSENT_MESSAGE = "Spojení se přerušilo, než se fotka odeslala. Nic se nenahrálo: zkuste to znovu.";

/** Progress is told to those who listen at most this often for each photo (4 times a second): a page that draws more often is busy with nothing else. */
const PROGRESS_INTERVAL_MS = 250;

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });

/** "45 s", "1 minutu", "4 minuty", "5 minut" (after "za"). */
function duration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${czechPlural(minutes, "minutu", "minuty", "minut")}`;
}

/** A message of the server that already says when to come back ("Zkuste to znovu za 4 minuty.", "… a zkuste to znovu.", "zkuste to za chvíli"). */
const SAYS_WHEN_TO_RETRY = /zkuste\s+to\s+(znovu|za|později)/i;

/** The server's own words, once: the client's sentence about when to try again is added only when the server's message has no such hint. */
export function withRetryHint(message: string, seconds: number): string {
  return SAYS_WHEN_TO_RETRY.test(message) ? message : `${message} Zkuste to znovu za ${duration(seconds)}.`;
}

/** "Nahráno 3 z 5", and "(nepodařilo se 2)" when some did not go. Empty for nothing. */
export function uploadSummary({ total, done, failed }: { total: number; done: number; failed: number }): string {
  if (total === 0) return "";
  return `Nahráno ${done} z ${total}${failed > 0 ? ` (nepodařilo se ${failed})` : ""}`;
}

/** "2 fotky se nenahrály: nahrajte je znovu, nebo je zahoďte." (the forms of Czech for the number). */
export function failedPhotosSentence(n: number): string {
  const what = n === 1 ? "fotka se nenahrála" : n <= 4 ? "fotky se nenahrály" : "fotek se nenahrálo";
  const them = n === 1 ? "ji" : "je";
  return `${n} ${what}: nahrajte ${them} znovu, nebo ${them} zahoďte.`;
}

interface Item<V> extends UploadEntry<V> {
  file: File;
  /** When progress was last told to those who listen (for the limit of how often). */
  toldAt: number | null;
}

export class UploadQueue<V> {
  private items: Item<V>[] = [];
  private nextId = 1;
  private active = 0;
  /** Changes when the queue is abandoned: what is still on its way from before must not touch what comes after. */
  private generation = 0;
  private controller = new AbortController();
  /** The session ended: nothing is sent until the person asks again. */
  private halted = false;
  private listeners = new Set<() => void>();
  private snapshot: UploadSnapshot<V>;
  private summary: UploadSummary;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly maxAutoWaitSeconds: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private handlers: QueueHandlers<V>;
  private readonly send: Sender<V>;

  constructor(send: Sender<V>, options: QueueOptions<V> = {}) {
    this.send = send;
    this.concurrency = options.concurrency ?? 2;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.maxAutoWaitSeconds = options.maxAutoWaitSeconds ?? 30;
    this.sleep = options.sleep ?? wait;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.handlers = { onDone: options.onDone, onLost: options.onLost };
    this.snapshot = this.build();
    this.summary = { running: false, failed: 0, done: 0, total: 0 };
  }

  getSnapshot = (): UploadSnapshot<V> => this.snapshot;

  /** What a page that only needs to know whether something is going and how many failed reads: the same object until one of those changes. */
  getSummary = (): UploadSummary => this.summary;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replaces what is told of the photos that arrive and of the ones that may have (a page gives the functions of its latest render). */
  setHandlers(handlers: QueueHandlers<V>): void {
    this.handlers = handlers;
  }

  /** Adds files to the queue and starts sending. Photos that arrived are dropped from an idle list first (the failed ones stay). */
  add(files: readonly File[]): void {
    if (files.length === 0) return;
    if (!this.isRunning()) this.items = this.items.filter((i) => i.status !== "done");
    this.halted = false;
    for (const file of files) {
      this.items.push({
        id: this.nextId++,
        file,
        name: file.name,
        size: file.size,
        status: "waiting",
        progress: 0,
        attempt: 0,
        retryInSeconds: null,
        error: null,
        retryable: false,
        maybeStored: false,
        value: null,
        toldAt: null,
      });
    }
    this.emit();
    this.pump();
  }

  private reset(item: Item<V>): void {
    Object.assign(item, { status: "waiting", attempt: 0, progress: 0, retryInSeconds: null, error: null, retryable: false, maybeStored: false, toldAt: null });
  }

  /** Sends again every photo that failed and may pass the next time. */
  retryFailed(): void {
    let any = false;
    for (const item of this.items) {
      if (item.status !== "failed" || !item.retryable) continue;
      this.reset(item);
      any = true;
    }
    if (!any) return;
    this.halted = false;
    this.emit();
    this.pump();
  }

  /** Sends the photo [id] again, if it failed and may pass the next time; anything else is left as it is. */
  retry(id: number): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "failed" || !item.retryable) return;
    this.reset(item);
    this.halted = false;
    this.emit();
    this.pump();
  }

  /** Takes a failed photo off the list: the person has decided not to send it. Nothing is deleted anywhere; a photo that waits or is on its way stays. */
  discard(id: number): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => !(i.id === id && i.status === "failed"));
    if (this.items.length !== before) this.emit();
  }

  /** Takes off the list the photos that arrived and the failures that the person has read; what is still going stays. */
  clearFinished(): void {
    this.items = this.items.filter((i) => i.status !== "done" && i.status !== "failed");
    this.emit();
  }

  /** The person left: what is on its way is told to stop, what waits is forgotten, and the queue is ready for the next choice. */
  abort(): void {
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    this.items = [];
    this.active = 0;
    this.halted = false;
    this.emit();
  }

  private isRunning(): boolean {
    return this.items.some((i) => i.status === "waiting" || i.status === "uploading" || i.status === "retrying");
  }

  private build(): UploadSnapshot<V> {
    const entries = this.items.map(({ file: _file, toldAt: _toldAt, ...entry }) => entry);
    return {
      entries,
      total: entries.length,
      done: entries.filter((e) => e.status === "done").length,
      failed: entries.filter((e) => e.status === "failed").length,
      running: this.isRunning(),
    };
  }

  private emit(): void {
    this.snapshot = this.build();
    const { running, failed, done, total } = this.snapshot;
    const s = this.summary;
    if (s.running !== running || s.failed !== failed || s.done !== done || s.total !== total) this.summary = { running, failed, done, total };
    for (const listener of [...this.listeners]) listener();
  }

  private pump(): void {
    if (this.halted) return;
    while (this.active < this.concurrency) {
      const next = this.items.find((i) => i.status === "waiting");
      if (!next) return;
      // taken before anything is awaited, so the next turn of this loop does not take it again
      next.status = "uploading";
      this.active += 1;
      const generation = this.generation;
      void this.run(next, generation).finally(() => {
        if (generation !== this.generation) return;
        this.active -= 1;
        this.pump();
      });
    }
  }

  private fail(item: Item<V>, error: string, retryable: boolean, maybeStored = false): void {
    Object.assign(item, { status: "failed", error, retryable, maybeStored, retryInSeconds: null });
    this.emit();
    if (maybeStored) this.handlers.onLost?.();
  }

  /** The seconds to wait before a second try: what the server said (never less, up to 30 % more), or 5 s, give or take 30 %; half as long again, or twice, at every try. */
  private waitSeconds(base: number | null, attempt: number): number {
    const r = this.random();
    if (base !== null) return base * 1.5 ** (attempt - 1) * (1 + 0.3 * r);
    return 5 * 2 ** (attempt - 1) * (0.7 + 0.6 * r);
  }

  private async run(item: Item<V>, generation: number): Promise<void> {
    const signal = this.controller.signal;
    for (;;) {
      item.attempt += 1;
      Object.assign(item, { status: "uploading", progress: 0, retryInSeconds: null, toldAt: null });
      this.emit();
      let outcome: SendOutcome<V>;
      try {
        outcome = await this.send(
          item.file,
          (fraction) => {
            if (generation !== this.generation || item.status !== "uploading" || !Number.isFinite(fraction)) return;
            item.progress = Math.max(item.progress, Math.min(1, Math.max(0, fraction)));
            // Told to those who listen at once for the first and for the last, and between them at most four times a second: the page does not
            // draw itself for every event of the browser (the progress that was not told is in the next snapshot).
            const at = this.now();
            if (item.progress >= 1 || item.toldAt === null || at - item.toldAt >= PROGRESS_INTERVAL_MS) {
              item.toldAt = at;
              this.emit();
            }
          },
          signal,
        );
      } catch {
        outcome = { kind: "lost" };
      }
      if (generation !== this.generation) return;

      switch (outcome.kind) {
        case "ok": {
          Object.assign(item, { status: "done", progress: 1, error: null, retryable: false, maybeStored: false, value: outcome.value });
          this.emit();
          const { file: _file, toldAt: _toldAt, ...entry } = item;
          this.handlers.onDone?.(entry, outcome.value);
          return;
        }
        case "busy": {
          if (item.attempt >= this.maxAttempts) return this.fail(item, outcome.message, true);
          // Whether to wait at all is decided by what the server said, not by what the jitter made of it.
          if (outcome.retryAfterSeconds !== null && outcome.retryAfterSeconds > this.maxAutoWaitSeconds) {
            return this.fail(item, withRetryHint(outcome.message, outcome.retryAfterSeconds), true);
          }
          const seconds = Math.max(1, this.waitSeconds(outcome.retryAfterSeconds, item.attempt));
          Object.assign(item, { status: "retrying", retryInSeconds: Math.ceil(seconds) });
          this.emit();
          await this.sleep(Math.round(seconds * 1000), signal);
          if (generation !== this.generation) return;
          continue;
        }
        case "rejected":
          return this.fail(item, outcome.message, outcome.status >= 500 || outcome.status === 408);
        case "lost":
          return this.fail(item, outcome.reason === "gateway" ? GATEWAY_MESSAGE : LOST_MESSAGE, true, true);
        case "unsent":
          return this.fail(item, UNSENT_MESSAGE, true);
        case "expired": {
          this.halted = true;
          this.fail(item, outcome.message, true);
          for (const waiting of this.items) if (waiting.status === "waiting") this.fail(waiting, outcome.message, true);
          return;
        }
      }
    }
  }
}
