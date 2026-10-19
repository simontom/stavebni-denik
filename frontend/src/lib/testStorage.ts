import type { StorageLike } from "./draftStore";

/** `localStorage` in memory, for the unit tests; `failing` makes accesses throw, as a blocked or full storage does. */
export class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  failing: "none" | "all" | "write" = "none";

  get length(): number {
    if (this.failing === "all") throw new Error("storage blocked");
    return this.items.size;
  }
  key(index: number): string | null {
    if (this.failing === "all") throw new Error("storage blocked");
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failing === "all") throw new Error("storage blocked");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failing !== "none") throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failing === "all") throw new Error("storage blocked");
    this.items.delete(key);
  }
}
