/**
 * What the application knows about work that leaving would lose: text typed into a form or a dialog, a temporary password that
 * has not been handed over, an action that is still running. Two things read it: the question that is asked before a page is left
 * (a link, the Back button, logging out: `AppLayout`) and the browser's own question before the tab is closed or reloaded
 * (`beforeunload`, registered once in `AppLayout`). A lapsed session also keeps a page that holds unsaved work where it is.
 *
 * Two ways to say it, which do not interfere with each other:
 *  - the page's own slot, `setUnsavedWork` (the form of an entry, the project's identification form): one value, replaced;
 *  - a registration, `registerUnsavedWork` (a dialog, a question): any number at once, each taken away by the function it returned,
 *    so a dialog that closes cannot take away what another one is still holding.
 * [discardUnsavedWork] gives up everything at once: the person has said they leave anyway.
 */

export interface UnsavedWorkOptions {
  /** The text is also kept on this device as a draft, so leaving does not lose it (what the question tells the person). */
  keptAsDraft?: boolean;
  /** What leaving loses, in words, when "Stránka má neuložené změny" would not say it (a password that cannot be shown again). */
  message?: string;
}

const registrations = new Set<UnsavedWorkOptions>();
let slot: UnsavedWorkOptions | null = null;

/** A page with typed-in, unsaved work says so (its own slot). [keptAsDraft]: the text is also kept on this device. */
export function setUnsavedWork(value: boolean, keptAsDraft = false): void {
  slot = value ? { keptAsDraft } : null;
}

/** A dialog or a question says it holds work for as long as it is on the screen; call the result to say it no longer does. */
export function registerUnsavedWork(options: UnsavedWorkOptions = {}): () => void {
  const entry = { ...options };
  registrations.add(entry);
  return () => {
    registrations.delete(entry);
  };
}

/** The person leaves anyway (logging out, the sign-in dialog's "Odhlásit"): nothing counts as unsaved any more. */
export function discardUnsavedWork(): void {
  registrations.clear();
  slot = null;
}

function all(): UnsavedWorkOptions[] {
  return slot ? [...registrations, slot] : [...registrations];
}

export function hasUnsavedWork(): boolean {
  return registrations.size > 0 || slot !== null;
}

/** The unsaved work is also kept on this device as a draft: everything that is unsaved is. */
export function unsavedWorkIsKeptAsDraft(): boolean {
  const work = all();
  return work.length > 0 && work.every((w) => w.keptAsDraft === true);
}

/** What leaving would lose, in the words of the latest registration that has some; none when nobody said (the question has its own words). */
export function unsavedWorkMessage(): string | undefined {
  return [...registrations].reverse().find((w) => w.message)?.message;
}
