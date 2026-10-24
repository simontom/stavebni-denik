import { useEffect } from "react";

/** The name of the application: the last part of every title (the same as the `<title>` of `index.html`). */
export const APP_NAME = "Stavební deník";

/**
 * The `<title>` of a page: the most specific part first and the name of the application last, joined by an en dash
 * ("Přihlášení – Stavební deník"; "Záznam č. 5 / 28. 9. 2026 – Hala Brno – Stavební deník"). A part that is not known (yet) or is
 * blank is left out, so a page that is still loading says no more than the name of the application.
 */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  return [...parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)), APP_NAME].join(" – ");
}

/**
 * Gives the page its `<title>` while it is shown and changes it when the parts change (a project's name once it has loaded, the
 * number of an entry once it has been signed). Every page after sign-in and the sign-in page itself call this; the page that is
 * shown next sets its own, so nothing needs to be put back.
 */
export function usePageTitle(...parts: (string | null | undefined)[]): void {
  const title = pageTitle(...parts);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
