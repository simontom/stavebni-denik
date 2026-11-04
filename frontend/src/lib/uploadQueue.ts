/**
 * The queue behind "several photos at once" (backlog B5), as plain logic so the unit tests cover it (the browser parts are
 * `photoUpload.ts` and `usePhotoUploads.ts`). Photos go one per request, at most two requests at a time: the server lets a person
 * have two uploads in flight and answers a third with `429` (PROJECT.md, "Request and upload limits"), and takes 60 uploads in 5 minutes.
 *
 * What each answer of the server makes of a photo:
 *  - stored: done;
 *  - `429` or `503` (busy; the server did not take the photo): wait as long as `Retry-After` says (5 s, 10 s, 20 s when it says nothing)
 *    and send the same photo again, four tries at most, and a wait over `maxAutoWaitSeconds` is not waited for with the page open: the
 *    photo fails at once and says when to try again. The photo keeps its place while it waits, so two at a time still holds;
 *  - any other refusal (`4xx`): failed, and sending it again would be refused again (a `5xx` may pass the next time: "Zkusit znovu");
 *  - the connection was lost: failed, **never sent again by itself**. The photo may have arrived, a photo cannot be taken off an entry
 *    (backlog A4 is the owner's decision), and a second copy would stay for good: the person looks and decides;
 *  - the session ended (`401`): this photo and every one that waits fail with the same words and nothing more is sent until the person asks.
 * A photo that fails never holds the others back.
 */
import { czechPlural } from "./czech";

export type SendOutcome<V> =
  | { kind: "ok"; value: V }
  /** `429` or `503`: the server turned the photo away before it took it, so sending it again is safe. */
  | { kind: "busy"; status: number; message: string; retryAfterSeconds: number | null }
  /** The server refused the photo (any other status): [status] 5xx may be a passing fault. */
  | { kind: "rejected"; status: number; message: string }
  /** No answer came (the connection was lost, the request timed out): it is not known whether the photo arrived. */
  | { kind: "lost" }
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

export interface QueueOptions<V> {
  /** Requests at a time (2: what the server allows a person). */
  concurrency?: number;
  /** Times a photo is sent when the server is busy, the first one included. */
  maxAttempts?: number;
  /** The longest wait that is waited for with the page open; a longer `Retry-After` fails the photo at once. */
  maxAutoWaitSeconds?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** A photo arrived (called once for each, in the order they arrive). */
  onDone?: (entry: UploadEntry<V>, value: V) => void;
}

export const LOST_MESSAGE = "Spojení se přerušilo. Fotka se možná nahrála: podívejte se, jestli je mezi fotkami, než ji pošlete znovu.";

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

/** "Nahráno 3 z 5", and "(nepodařilo se 2)" when some did not go. Empty for nothing. */
export function uploadSummary({ total, done, failed }: { total: number; done: number; failed: number }): string {
  if (total === 0) return "";
  return `Nahráno ${done} z ${total}${failed > 0 ? ` (nepodařilo se ${failed})` : ""}`;
}

interface Item<V> extends UploadEntry<V> {
  file: File;
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
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly maxAutoWaitSeconds: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly onDone?: (entry: UploadEntry<V>, value: V) => void;
  private readonly send: Sender<V>;

  constructor(send: Sender<V>, options: QueueOptions<V> = {}) {
    this.send = send;
    this.concurrency = options.concurrency ?? 2;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.maxAutoWaitSeconds = options.maxAutoWaitSeconds ?? 30;
    this.sleep = options.sleep ?? wait;
    this.onDone = options.onDone;
    this.snapshot = this.build();
  }

  getSnapshot = (): UploadSnapshot<V> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

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
        value: null,
      });
    }
    this.emit();
    this.pump();
  }

  /** Sends again every photo that failed and may pass the next time. */
  retryFailed(): void {
    let any = false;
    for (const item of this.items) {
      if (item.status !== "failed" || !item.retryable) continue;
      Object.assign(item, { status: "waiting", attempt: 0, progress: 0, retryInSeconds: null, error: null, retryable: false });
      any = true;
    }
    if (!any) return;
    this.halted = false;
    this.emit();
    this.pump();
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
    const entries = this.items.map(({ file: _file, ...entry }) => entry);
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

  private fail(item: Item<V>, error: string, retryable: boolean): void {
    Object.assign(item, { status: "failed", error, retryable, retryInSeconds: null });
    this.emit();
  }

  private async run(item: Item<V>, generation: number): Promise<void> {
    const signal = this.controller.signal;
    for (;;) {
      item.attempt += 1;
      Object.assign(item, { status: "uploading", progress: 0, retryInSeconds: null });
      this.emit();
      let outcome: SendOutcome<V>;
      try {
        outcome = await this.send(
          item.file,
          (fraction) => {
            if (generation !== this.generation || item.status !== "uploading" || !Number.isFinite(fraction)) return;
            item.progress = Math.max(item.progress, Math.min(1, Math.max(0, fraction)));
            this.emit();
          },
          signal,
        );
      } catch {
        outcome = { kind: "lost" };
      }
      if (generation !== this.generation) return;

      switch (outcome.kind) {
        case "ok": {
          Object.assign(item, { status: "done", progress: 1, error: null, retryable: false, value: outcome.value });
          this.emit();
          const { file: _file, ...entry } = item;
          this.onDone?.(entry, outcome.value);
          return;
        }
        case "busy": {
          if (item.attempt >= this.maxAttempts) return this.fail(item, outcome.message, true);
          const seconds = Math.max(1, outcome.retryAfterSeconds ?? 5 * 2 ** (item.attempt - 1));
          if (seconds > this.maxAutoWaitSeconds) return this.fail(item, `${outcome.message} Zkuste to znovu za ${duration(seconds)}.`, true);
          Object.assign(item, { status: "retrying", retryInSeconds: seconds });
          this.emit();
          await this.sleep(seconds * 1000, signal);
          if (generation !== this.generation) return;
          continue;
        }
        case "rejected":
          return this.fail(item, outcome.message, outcome.status >= 500);
        case "lost":
          return this.fail(item, LOST_MESSAGE, true);
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
