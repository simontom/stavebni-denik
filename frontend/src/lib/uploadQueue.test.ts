import { describe, expect, it } from "vitest";
import { GATEWAY_MESSAGE, LOST_MESSAGE, UNSENT_MESSAGE, UploadQueue, failedPhotosSentence, uploadSummary, type SendOutcome, type Sender } from "./uploadQueue";

const file = (name: string) => new File(["x"], name, { type: "image/jpeg" });
const files = (...names: string[]) => names.map(file);

/** What a test needs to hand out answers one at a time: every call of the sender waits until the test answers it. */
function controlledSender() {
  const calls: { name: string; attempt: number; progress: (fraction: number) => void; signal: AbortSignal; answer: (outcome: SendOutcome<string>) => void }[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  const send: Sender<string> = (f, progress, signal) =>
    new Promise((resolve) => {
      const attempt = (attempts.get(f.name) ?? 0) + 1;
      attempts.set(f.name, attempt);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      calls.push({
        name: f.name,
        attempt,
        progress,
        signal,
        answer: (outcome) => {
          inFlight -= 1;
          resolve(outcome);
        },
      });
    });
  return {
    send,
    calls,
    get peak() {
      return peak;
    },
    get inFlight() {
      return inFlight;
    },
    /** The open (unanswered) calls, by file name. */
    open: () => calls.filter((c) => !answered.has(c)).map((c) => c.name),
    /** Answers the oldest open call of [name]. */
    answer(name: string, outcome: SendOutcome<string>) {
      const call = calls.find((c) => c.name === name && !answered.has(c));
      if (!call) throw new Error(`no open call for ${name}`);
      answered.add(call);
      call.answer(outcome);
    },
  };
}
const answered = new WeakSet<object>();

const ok = (value: string): SendOutcome<string> => ({ kind: "ok", value });
const busy = (retryAfterSeconds: number | null, status = 429): SendOutcome<string> => ({
  kind: "busy",
  status,
  message: "Právě se nahrává další vaše fotografie.",
  retryAfterSeconds,
});

/** Lets every promise that can run run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A sleep that a test releases by hand, and that writes down how long it was asked to wait. */
function controlledSleep() {
  const asked: number[] = [];
  const waiting: (() => void)[] = [];
  return {
    asked,
    sleep: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        asked.push(ms);
        waiting.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    release() {
      waiting.splice(0).forEach((resolve) => resolve());
    },
    get pending() {
      return waiting.length;
    },
  };
}

const instantSleep = (asked: number[]) => async (ms: number) => {
  asked.push(ms);
};

describe("UploadQueue: several photos, two requests at a time", () => {
  it("sends one photo per request, never more than two at once, and starts the next as soon as one is done", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg"));
    await flush();
    expect(s.open()).toEqual(["1.jpg", "2.jpg"]);

    s.answer("1.jpg", ok("p1"));
    await flush();
    expect(s.open()).toEqual(["2.jpg", "3.jpg"]);
    s.answer("3.jpg", ok("p3"));
    await flush();
    expect(s.open()).toEqual(["2.jpg", "4.jpg"]);
    s.answer("2.jpg", ok("p2"));
    s.answer("4.jpg", ok("p4"));
    await flush();
    expect(s.open()).toEqual(["5.jpg"]);
    s.answer("5.jpg", ok("p5"));
    await flush();

    expect(s.peak).toBe(2);
    const snapshot = queue.getSnapshot();
    expect(snapshot.running).toBe(false);
    expect(snapshot.entries.map((e) => e.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(snapshot.entries.map((e) => e.value)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("reports each photo as it arrives, with the answer of the server, and in the order they arrived", async () => {
    const s = controlledSender();
    const arrived: string[] = [];
    const queue = new UploadQueue<string>(s.send, { onDone: (entry, value) => arrived.push(`${entry.name}=${value}`) });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    s.answer("b.jpg", ok("B"));
    await flush();
    s.answer("a.jpg", ok("A"));
    await flush();
    expect(arrived).toEqual(["b.jpg=B", "a.jpg=A"]);
  });

  it("shows the progress of each photo, from 0 to 1", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    expect(queue.getSnapshot().entries.map((e) => [e.status, e.progress])).toEqual([
      ["uploading", 0],
      ["uploading", 0],
      ["waiting", 0],
    ]);
    s.calls[0].progress(0.4);
    s.calls[1].progress(1);
    expect(queue.getSnapshot().entries.map((e) => e.progress)).toEqual([0.4, 1, 0]);
    s.calls[0].progress(7); // a number out of range is held to the range, and a smaller one never takes progress back
    s.calls[0].progress(0.2);
    expect(queue.getSnapshot().entries[0].progress).toBe(1);
    s.answer("a.jpg", ok("A"));
    await flush();
    expect(queue.getSnapshot().entries[0]).toMatchObject({ status: "done", progress: 1 });
  });

  it("counts what has arrived, for 'Nahráno 3 z 5'", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg"));
    await flush();
    s.answer("1.jpg", ok("p"));
    await flush();
    s.answer("2.jpg", ok("p"));
    await flush();
    s.answer("3.jpg", ok("p"));
    await flush();
    const snapshot = queue.getSnapshot();
    expect(snapshot).toMatchObject({ total: 5, done: 3, failed: 0, running: true });
    expect(uploadSummary(snapshot)).toBe("Nahráno 3 z 5");
  });
});

describe("UploadQueue: a server that is busy", () => {
  it("waits as long as the server says (Retry-After) and sends the same photo again; the other photo goes on meanwhile", async () => {
    const s = controlledSender();
    const z = controlledSleep();
    const queue = new UploadQueue<string>(s.send, { sleep: z.sleep, random: () => 0 });
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    s.answer("a.jpg", busy(2));
    await flush();
    // a.jpg waits for its second try; b.jpg is still being sent; c.jpg waits for a free place (a.jpg keeps its place while it waits: two at a time)
    expect(z.asked).toEqual([2000]);
    expect(queue.getSnapshot().entries[0]).toMatchObject({ status: "retrying", retryInSeconds: 2, attempt: 1 });
    expect(s.open()).toEqual(["b.jpg"]);

    z.release();
    await flush();
    expect(s.open()).toEqual(["b.jpg", "a.jpg"]);
    expect(queue.getSnapshot().entries[0]).toMatchObject({ status: "uploading", attempt: 2, progress: 0 });
    s.answer("a.jpg", ok("A"));
    s.answer("b.jpg", ok("B"));
    await flush();
    s.answer("c.jpg", ok("C"));
    await flush();
    expect(queue.getSnapshot()).toMatchObject({ done: 3, failed: 0, running: false });
    expect(s.peak).toBe(2);
  });

  it("gives up on a photo after four tries and says what the server said, with the others undisturbed", async () => {
    const s = controlledSender();
    const asked: number[] = [];
    const queue = new UploadQueue<string>(s.send, { sleep: instantSleep(asked), random: () => 0 });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    s.answer("b.jpg", ok("B"));
    for (let attempt = 1; attempt <= 4; attempt++) {
      await flush();
      expect(s.open()).toEqual(["a.jpg"]);
      s.answer("a.jpg", busy(3, 503));
    }
    await flush();
    expect(asked).toEqual([3000, 4500, 6750]); // three waits between four tries, each one half as long again as the server's time
    expect(s.open()).toEqual([]);
    const [a, b] = queue.getSnapshot().entries;
    expect(a).toMatchObject({ status: "failed", attempt: 4, retryable: true, error: "Právě se nahrává další vaše fotografie." });
    expect(b.status).toBe("done");
    expect(queue.getSnapshot()).toMatchObject({ done: 1, failed: 1, running: false });
    expect(uploadSummary(queue.getSnapshot())).toBe("Nahráno 1 z 2 (nepodařilo se 1)");
  });

  it("waits 5 s, then 10 s and 20 s, when the server gave no time", async () => {
    const s = controlledSender();
    const asked: number[] = [];
    const queue = new UploadQueue<string>(s.send, { sleep: instantSleep(asked), random: () => 0.5 });
    queue.add(files("a.jpg"));
    for (let i = 0; i < 4; i++) {
      await flush();
      s.answer("a.jpg", busy(null));
    }
    await flush();
    expect(asked).toEqual([5000, 10000, 20000]);
  });

  it("does not wait minutes with the page open: a long Retry-After fails the photo at once, and says when to try again", async () => {
    const s = controlledSender();
    const asked: number[] = [];
    const queue = new UploadQueue<string>(s.send, { sleep: instantSleep(asked) });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    s.answer("a.jpg", busy(240));
    await flush();
    expect(asked).toEqual([]);
    const a = queue.getSnapshot().entries[0];
    expect(a).toMatchObject({ status: "failed", retryable: true });
    expect(a.error).toBe("Právě se nahrává další vaše fotografie. Zkuste to znovu za 4 minuty.");
    expect(s.open()).toEqual(["b.jpg"]); // the other goes on
  });

  it("says the wait in seconds, minutes or the form that goes with the number", async () => {
    const wait = async (seconds: number) => {
      const s = controlledSender();
      const queue = new UploadQueue<string>(s.send, { maxAutoWaitSeconds: 0 });
      queue.add(files("a.jpg"));
      await flush();
      s.answer("a.jpg", busy(seconds));
      await flush();
      return queue.getSnapshot().entries[0].error;
    };
    expect(await wait(45)).toBe("Právě se nahrává další vaše fotografie. Zkuste to znovu za 45 s.");
    expect(await wait(60)).toBe("Právě se nahrává další vaše fotografie. Zkuste to znovu za 1 minutu.");
    expect(await wait(100)).toBe("Právě se nahrává další vaše fotografie. Zkuste to znovu za 2 minuty.");
    expect(await wait(300)).toBe("Právě se nahrává další vaše fotografie. Zkuste to znovu za 5 minut.");
  });
});

describe("UploadQueue: a photo that fails never blocks the others", () => {
  it("keeps the photos the server refused out of the way and sends the rest", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "rejected", status: 400, message: "Soubor není platný obrázek" });
    await flush();
    expect(s.open()).toEqual(["b.jpg", "c.jpg"]);
    s.answer("b.jpg", ok("B"));
    s.answer("c.jpg", ok("C"));
    await flush();
    const [a] = queue.getSnapshot().entries;
    expect(a).toMatchObject({ status: "failed", error: "Soubor není platný obrázek", retryable: false, attempt: 1 });
    expect(queue.getSnapshot()).toMatchObject({ done: 2, failed: 1, running: false });
  });

  it("does not try a refused photo again by itself, and 'Zkusit znovu' does not send it again either: it would be refused again", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "rejected", status: 403, message: "K tomuto záznamu nemáte právo přidávat fotografie" });
    await flush();
    queue.retryFailed();
    await flush();
    expect(s.open()).toEqual([]);
    expect(queue.getSnapshot().entries[0].status).toBe("failed");
  });

  it("sends a photo again after a server error (500) when asked, but never by itself", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "rejected", status: 500, message: "Fotku se nepodařilo uložit" });
    await flush();
    expect(s.open()).toEqual([]);
    expect(queue.getSnapshot().entries[0]).toMatchObject({ status: "failed", retryable: true });
    queue.retryFailed();
    await flush();
    expect(s.open()).toEqual(["a.jpg"]);
    expect(queue.getSnapshot()).toMatchObject({ running: true, failed: 0 });
    s.answer("a.jpg", ok("A"));
    await flush();
    expect(queue.getSnapshot()).toMatchObject({ done: 1, failed: 0, running: false });
  });

  it("does not send a photo again by itself when the connection was lost: it may have arrived, and a photo cannot be taken off an entry", async () => {
    const s = controlledSender();
    const asked: number[] = [];
    const queue = new UploadQueue<string>(s.send, { sleep: instantSleep(asked) });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "lost" });
    await flush();
    expect(asked).toEqual([]);
    expect(s.calls.filter((c) => c.name === "a.jpg")).toHaveLength(1);
    const [a] = queue.getSnapshot().entries;
    expect(a).toMatchObject({ status: "failed", retryable: true });
    expect(a).toMatchObject({ maybeStored: true });
    expect(a.error).toBe(LOST_MESSAGE);
    // the person decides
    s.answer("b.jpg", ok("B"));
    queue.retryFailed();
    await flush();
    expect(s.open()).toEqual(["a.jpg"]);
  });
});

describe("UploadQueue: a session that has ended", () => {
  it("fails the photo and every one that waits with the same words and sends nothing more, until the person asks again", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg", "c.jpg", "d.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "expired", message: "Přihlášení vypršelo. Přihlaste se znovu a zkuste to ještě jednou." });
    await flush();
    // b.jpg was already on its way: it is answered by the server like the first (the same expired session)
    expect(s.open()).toEqual(["b.jpg"]);
    s.answer("b.jpg", { kind: "expired", message: "Přihlášení vypršelo. Přihlaste se znovu a zkuste to ještě jednou." });
    await flush();
    expect(s.open()).toEqual([]);
    const statuses = queue.getSnapshot().entries.map((e) => [e.status, e.error]);
    expect(statuses).toEqual(Array(4).fill(["failed", "Přihlášení vypršelo. Přihlaste se znovu a zkuste to ještě jednou."]));
    expect(queue.getSnapshot().running).toBe(false);

    queue.retryFailed();
    await flush();
    expect(s.open()).toEqual(["a.jpg", "b.jpg"]);
    expect(queue.getSnapshot().entries.map((e) => e.status)).toEqual(["uploading", "uploading", "waiting", "waiting"]);
    expect(queue.getSnapshot().entries.every((e) => e.error === null)).toBe(true);
  });
});

describe("UploadQueue: the list", () => {
  it("is running while anything waits, is on its way or waits for a second try, and not otherwise", async () => {
    const s = controlledSender();
    const z = controlledSleep();
    const queue = new UploadQueue<string>(s.send, { sleep: z.sleep });
    expect(queue.getSnapshot().running).toBe(false);
    queue.add(files("a.jpg"));
    await flush();
    expect(queue.getSnapshot().running).toBe(true);
    s.answer("a.jpg", busy(2));
    await flush();
    expect(queue.getSnapshot().running, "while it waits for its second try").toBe(true);
    z.release();
    await flush();
    s.answer("a.jpg", ok("A"));
    await flush();
    expect(queue.getSnapshot().running).toBe(false);
  });

  it("tells those who listen at every change, with a new snapshot each time and the same one in between", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    let notified = 0;
    const stop = queue.subscribe(() => (notified += 1));
    const before = queue.getSnapshot();
    expect(queue.getSnapshot()).toBe(before);
    queue.add(files("a.jpg"));
    await flush();
    expect(notified).toBeGreaterThan(0);
    const during = queue.getSnapshot();
    expect(during).not.toBe(before);
    expect(queue.getSnapshot()).toBe(during);
    stop();
    const count = notified;
    s.answer("a.jpg", ok("A"));
    await flush();
    expect(notified).toBe(count);
  });

  it("drops the photos that arrived when a new choice is added to an idle list, and keeps the ones that failed", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    s.answer("a.jpg", ok("A"));
    s.answer("b.jpg", { kind: "lost" });
    await flush();
    expect(queue.getSnapshot()).toMatchObject({ total: 2, done: 1, failed: 1 });

    queue.add(files("c.jpg"));
    await flush();
    expect(queue.getSnapshot().entries.map((e) => e.name)).toEqual(["b.jpg", "c.jpg"]);
    expect(queue.getSnapshot()).toMatchObject({ total: 2, done: 0, failed: 1 });
  });

  it("clears what is finished (the photos that arrived and the failures the person has read) and leaves what is still going", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    s.answer("a.jpg", ok("A"));
    s.answer("b.jpg", { kind: "rejected", status: 400, message: "Soubor není platný obrázek" });
    await flush();
    queue.clearFinished();
    expect(queue.getSnapshot().entries.map((e) => e.name)).toEqual(["c.jpg"]);
    expect(queue.getSnapshot()).toMatchObject({ total: 1, done: 0, failed: 0, running: true });
  });

  it("adds files while others are going, and the two-at-a-time limit still holds", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    queue.add(files("c.jpg", "d.jpg"));
    await flush();
    expect(s.open()).toEqual(["a.jpg", "b.jpg"]);
    expect(queue.getSnapshot().total).toBe(4);
    for (const name of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) {
      s.answer(name, ok(name));
      await flush();
    }
    expect(s.peak).toBe(2);
    expect(queue.getSnapshot()).toMatchObject({ done: 4, running: false });
  });

  it("takes another number of requests when it is told to", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send, { concurrency: 1 });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    expect(s.open()).toEqual(["a.jpg"]);
  });
});

describe("UploadQueue.abort: the person left the page", () => {
  it("stops what is on its way (the sender is told), forgets what waits, and is ready for the next choice", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    const signals = s.calls.map((c) => c.signal);
    queue.abort();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    // the senders answer the way a cancelled request does
    s.answer("a.jpg", { kind: "lost" });
    s.answer("b.jpg", { kind: "lost" });
    await flush();
    expect(s.open()).toEqual([]); // c.jpg was never sent
    expect(queue.getSnapshot()).toMatchObject({ running: false, total: 0 });

    queue.add(files("d.jpg"));
    await flush();
    expect(s.open()).toEqual(["d.jpg"]);
    expect(s.calls.at(-1)!.signal.aborted).toBe(false);
  });

  it("stops waiting for a second try", async () => {
    const s = controlledSender();
    const z = controlledSleep();
    const queue = new UploadQueue<string>(s.send, { sleep: z.sleep });
    queue.add(files("a.jpg"));
    await flush();
    s.answer("a.jpg", busy(5));
    await flush();
    queue.abort();
    await flush();
    expect(s.calls).toHaveLength(1); // not sent again
    expect(queue.getSnapshot().running).toBe(false);
  });
});

describe("uploadSummary", () => {
  it("says how many photos of the choice have arrived, and how many have not", () => {
    expect(uploadSummary({ total: 5, done: 3, failed: 0 })).toBe("Nahráno 3 z 5");
    expect(uploadSummary({ total: 5, done: 5, failed: 0 })).toBe("Nahráno 5 z 5");
    expect(uploadSummary({ total: 5, done: 2, failed: 2 })).toBe("Nahráno 2 z 5 (nepodařilo se 2)");
    expect(uploadSummary({ total: 0, done: 0, failed: 0 })).toBe("");
  });
});

describe("UploadQueue: the server's own words are said once", () => {
  // what RateLimiter.reserveOrRefuse says for the 61st upload in five minutes, with its Retry-After in seconds
  const LIMIT_MESSAGE = "Příliš mnoho nahrávání fotografií. Zkuste to znovu za 4 minuty.";
  const GATE_MESSAGE = "Právě se nahrává další vaše fotografie. Počkejte, až skončí, a zkuste to znovu.";

  const failedWith = async (message: string, seconds: number) => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "busy", status: 429, message, retryAfterSeconds: seconds });
    await flush();
    return queue.getSnapshot().entries[0];
  };

  it("does not add its own 'Zkuste to znovu za …' to a message of the server that has the hint in it", async () => {
    const a = await failedWith(LIMIT_MESSAGE, 240);
    expect(a).toMatchObject({ status: "failed", retryable: true });
    expect(a.error).toBe(LIMIT_MESSAGE);
    expect(a.error!.match(/zkuste to znovu/gi)).toHaveLength(1);
  });

  it("does not add it to the message of the gate either (it says 'zkuste to znovu' in lower case)", async () => {
    const a = await failedWith(GATE_MESSAGE, 300);
    expect(a.error).toBe(GATE_MESSAGE);
  });

  it("adds it to a message that says nothing of when to come back", async () => {
    const a = await failedWith("Server právě přijímá mnoho fotografií.", 100);
    expect(a.error).toBe("Server právě přijímá mnoho fotografií. Zkuste to znovu za 2 minuty.");
  });
});

describe("UploadQueue: waits that grow and are not the same for two tabs", () => {
  const waits = async (random: number, retryAfter: number | null, tries: number) => {
    const s = controlledSender();
    const asked: number[] = [];
    const queue = new UploadQueue<string>(s.send, { sleep: instantSleep(asked), random: () => random });
    queue.add(files("a.jpg"));
    for (let i = 0; i < tries; i++) {
      await flush();
      s.answer("a.jpg", busy(retryAfter));
    }
    await flush();
    return asked;
  };

  it("never waits less than the server said, and up to 30 % more, growing by half at every try", async () => {
    expect(await waits(0, 5, 4)).toEqual([5000, 7500, 11250]);
    expect(await waits(1, 5, 4)).toEqual([6500, 9750, 14625]);
    expect(await waits(0.5, 5, 1)).toEqual([5750]);
  });

  it("makes its own waits (the server gave none) 5, 10 and 20 s, give or take 30 %", async () => {
    expect(await waits(0, null, 4)).toEqual([3500, 7000, 14000]);
    expect(await waits(0.5, null, 4)).toEqual([5000, 10000, 20000]);
    expect(await waits(1, null, 4)).toEqual([6500, 13000, 26000]);
  });

  it("decides whether to wait at all by what the server said, not by what jitter made of it", async () => {
    expect(await waits(1, 30, 1)).toEqual([39000]); // 30 s is waited for, and a little more
    expect(await waits(0, 31, 1)).toEqual([]); // 31 s is not
  });
});

describe("UploadQueue: where the connection failed", () => {
  it("says of a photo whose connection was lost before its body had gone out that nothing arrived, and a second try is safe", async () => {
    const s = controlledSender();
    const lost: string[] = [];
    const queue = new UploadQueue<string>(s.send, { onLost: () => lost.push("lost") });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "unsent" });
    await flush();
    const [a] = queue.getSnapshot().entries;
    expect(a).toMatchObject({ status: "failed", retryable: true, maybeStored: false, error: UNSENT_MESSAGE });
    expect(lost, "nothing may have arrived: the page has no photo to look for").toEqual([]);
    expect(s.calls.filter((c) => c.name === "a.jpg")).toHaveLength(1); // not sent again by itself
  });

  it("marks only the photo whose body had gone out as possibly arrived, and tells the page to look at the photos of the entry", async () => {
    const s = controlledSender();
    const lost: string[] = [];
    const queue = new UploadQueue<string>(s.send, { onLost: () => lost.push("lost") });
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "lost" }); // sent, no answer
    s.answer("b.jpg", { kind: "unsent" }); // never went
    await flush();
    const [a, b, c] = queue.getSnapshot().entries;
    expect([a.maybeStored, b.maybeStored]).toEqual([true, false]);
    expect(a.error).toBe(LOST_MESSAGE);
    expect(b.error).toBe(UNSENT_MESSAGE);
    expect(c.status).toBe("uploading"); // goes on
    expect(lost).toEqual(["lost"]);
  });

  it("says of a gateway that did not answer (502, 504, a 503 without a wait) that the photo may have been saved, as for a lost connection", async () => {
    const s = controlledSender();
    const lost: string[] = [];
    const queue = new UploadQueue<string>(s.send, { onLost: () => lost.push("lost") });
    queue.add(files("a.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "lost", reason: "gateway" });
    await flush();
    expect(queue.getSnapshot().entries[0]).toMatchObject({ status: "failed", retryable: true, maybeStored: true, error: GATEWAY_MESSAGE });
    expect(lost).toEqual(["lost"]);
    expect(s.calls).toHaveLength(1); // never sent again by itself
  });

  it("offers a 408 (the server took nothing: it waited too long for the file) again, but does not send it by itself: a slow line would time out again", async () => {
    const s = controlledSender();
    const asked: number[] = [];
    const queue = new UploadQueue<string>(s.send, { sleep: instantSleep(asked) });
    queue.add(files("a.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "rejected", status: 408, message: "Nahrávání fotografie trvalo příliš dlouho, zkuste to znovu" });
    await flush();
    expect(queue.getSnapshot().entries[0]).toMatchObject({ status: "failed", retryable: true, maybeStored: false });
    expect(asked).toEqual([]);
    expect(s.calls).toHaveLength(1);
    queue.retryFailed();
    await flush();
    expect(s.calls).toHaveLength(2);
  });
});

describe("UploadQueue: one photo at a time", () => {
  const twoFailed = async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    s.answer("a.jpg", { kind: "unsent" });
    s.answer("b.jpg", { kind: "lost" });
    await flush();
    s.answer("c.jpg", { kind: "rejected", status: 400, message: "Soubor není platný obrázek" });
    await flush();
    return { s, queue };
  };

  it("sends again only the photo that was asked for", async () => {
    const { s, queue } = await twoFailed();
    const [a, b] = queue.getSnapshot().entries;
    queue.retry(b.id);
    await flush();
    expect(s.open()).toEqual(["b.jpg"]);
    expect(queue.getSnapshot().entries.map((e) => e.status)).toEqual(["failed", "uploading", "failed"]);
    expect(a.status).toBe("failed");
    s.answer("b.jpg", ok("B"));
    await flush();
    expect(queue.getSnapshot()).toMatchObject({ done: 1, failed: 2, running: false });
  });

  it("does not send a photo again that would be refused again, and ignores a photo that is not there or not failed", async () => {
    const { s, queue } = await twoFailed();
    const [a, , c] = queue.getSnapshot().entries;
    queue.retry(c.id);
    queue.retry(9999);
    await flush();
    expect(s.open()).toEqual([]);
    queue.retry(a.id);
    await flush();
    queue.retry(a.id); // already on its way
    await flush();
    expect(s.open()).toEqual(["a.jpg"]);
  });

  it("puts a failed photo away when the person discards it: nothing is deleted anywhere, it is only off the list", async () => {
    const { queue } = await twoFailed();
    const [a, b, c] = queue.getSnapshot().entries;
    queue.discard(b.id);
    expect(queue.getSnapshot().entries.map((e) => e.name)).toEqual(["a.jpg", "c.jpg"]);
    expect(queue.getSnapshot()).toMatchObject({ total: 2, failed: 2 });
    queue.discard(a.id);
    queue.discard(c.id);
    expect(queue.getSnapshot()).toMatchObject({ total: 0, failed: 0, running: false });
  });

  it("does not discard a photo that is waiting or on its way (it would be sent in spite of it)", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send);
    queue.add(files("a.jpg", "b.jpg", "c.jpg"));
    await flush();
    const entries = queue.getSnapshot().entries;
    for (const e of entries) queue.discard(e.id);
    expect(queue.getSnapshot().entries).toHaveLength(3);
  });
});

describe("UploadQueue: what a page that holds the whole page needs to know", () => {
  it("has a summary that does not change while progress comes in, so the page is not drawn again for it", async () => {
    const s = controlledSender();
    let now = 0;
    const queue = new UploadQueue<string>(s.send, { now: () => now });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    const summary = queue.getSummary();
    expect(summary).toEqual({ running: true, failed: 0, done: 0, total: 2 });
    for (let i = 1; i <= 8; i++) {
      now += 300;
      s.calls[0].progress(i / 10);
      s.calls[1].progress(i / 20);
    }
    expect(queue.getSnapshot().entries[0].progress).toBeCloseTo(0.8);
    expect(queue.getSummary(), "the same object: nothing a page reads has changed").toBe(summary);
    s.answer("a.jpg", ok("A"));
    await flush();
    expect(queue.getSummary()).toEqual({ running: true, failed: 0, done: 1, total: 2 });
    s.answer("b.jpg", { kind: "unsent" });
    await flush();
    expect(queue.getSummary()).toEqual({ running: false, failed: 1, done: 1, total: 2 });
  });

  it("tells those who listen about progress at most four times a second for each photo, and always when a photo is whole", async () => {
    const s = controlledSender();
    let now = 1000;
    const queue = new UploadQueue<string>(s.send, { now: () => now });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    let notified = 0;
    queue.subscribe(() => (notified += 1));
    s.calls[0].progress(0.05); // the first of a photo goes at once
    expect(notified).toBe(1);
    now += 100;
    s.calls[0].progress(0.1);
    now += 100;
    s.calls[0].progress(0.2);
    expect(notified, "two events within a quarter of a second are not told").toBe(1);
    expect(queue.getSnapshot().entries[0].progress).toBe(0.05);
    now += 100; // 300 ms since the last one told
    s.calls[0].progress(0.3);
    expect(notified).toBe(2);
    expect(queue.getSnapshot().entries[0].progress).toBe(0.3);
    s.calls[1].progress(0.4); // another photo has its own clock
    expect(notified).toBe(3);
    s.calls[0].progress(1); // whole: told at once
    expect(notified).toBe(4);
    expect(queue.getSnapshot().entries[0].progress).toBe(1);
  });

  it("keeps the progress that was not told, and tells it with the next change of anything", async () => {
    const s = controlledSender();
    const queue = new UploadQueue<string>(s.send, { now: () => 5000 });
    queue.add(files("a.jpg", "b.jpg"));
    await flush();
    s.calls[0].progress(0.1);
    s.calls[0].progress(0.6); // not told
    s.answer("b.jpg", ok("B"));
    await flush();
    expect(queue.getSnapshot().entries[0].progress).toBe(0.6);
  });
});

describe("failedPhotosSentence", () => {
  it("says how many photos did not go, in the forms of Czech, and what the person can do", () => {
    expect(failedPhotosSentence(1)).toBe("1 fotka se nenahrála: nahrajte ji znovu, nebo ji zahoďte.");
    expect(failedPhotosSentence(2)).toBe("2 fotky se nenahrály: nahrajte je znovu, nebo je zahoďte.");
    expect(failedPhotosSentence(4)).toBe("4 fotky se nenahrály: nahrajte je znovu, nebo je zahoďte.");
    expect(failedPhotosSentence(5)).toBe("5 fotek se nenahrálo: nahrajte je znovu, nebo je zahoďte.");
    expect(failedPhotosSentence(12)).toBe("12 fotek se nenahrálo: nahrajte je znovu, nebo je zahoďte.");
  });
});
