import { useEffect, useState } from "react";
import { isTextEntry, keyboardOpen, nextBaseline, type Baseline } from "./keyboard";

/**
 * Whether an on-screen keyboard is probably open (see `keyboard.ts`). It follows the visual viewport (`resize`), and where a browser has
 * none it falls back to a guess: a coarse pointer (a finger) with the focus in a field that is typed into. A mouse with the focus in a
 * field is not a keyboard that takes room, so it is never "open" there. Always false outside a browser.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport) {
      let baseline: Baseline | null = null;
      const measure = () => {
        baseline = nextBaseline(baseline, window.innerWidth, window.innerHeight);
        setOpen(keyboardOpen({ layoutWidth: window.innerWidth, layoutHeight: window.innerHeight, visualHeight: viewport.height, visualScale: viewport.scale }, baseline));
      };
      measure();
      viewport.addEventListener("resize", measure);
      window.addEventListener("resize", measure);
      return () => {
        viewport.removeEventListener("resize", measure);
        window.removeEventListener("resize", measure);
      };
    }
    // No visual viewport: the focus is all there is to go by (and only for a finger).
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    if (!coarse) return;
    const byFocus = () => setOpen(isTextEntry(document.activeElement));
    // `focusout` fires before the next control has the focus: look again once it has.
    const afterFocusMoves = () => void window.setTimeout(byFocus, 0);
    document.addEventListener("focusin", byFocus);
    document.addEventListener("focusout", afterFocusMoves);
    byFocus();
    return () => {
      document.removeEventListener("focusin", byFocus);
      document.removeEventListener("focusout", afterFocusMoves);
    };
  }, []);
  return open;
}
