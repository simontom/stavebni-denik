/**
 * Is an on-screen keyboard open? (backlog B5: the bar of actions is hidden while it is, because it would take a third of the little
 * room that is left above the keys.) Plain logic, so the unit tests cover it; `useKeyboardOpen` reads the browser and calls it.
 *
 * A page cannot ask whether a keyboard is open, only what the browser says about the viewport. On iOS and on Chrome for Android
 * (since version 108) the layout viewport keeps its height and the **visual** viewport (`window.visualViewport`) is shortened by the
 * keyboard; on older Chrome the layout viewport is resized as well. Both are caught by comparing the visual viewport with the greatest
 * height the page has had at this width. What is not a keyboard: a pinch-zoomed page (the visual viewport is shorter by the zoom, so
 * `scale` above 1 is ignored) and the address bar that collapses and comes back (60 to 80 px, under the threshold).
 */

/** The height of the page with no keyboard, at the width it was measured at (a turned phone or a resized window starts again). */
export interface Baseline {
  width: number;
  height: number;
}

export interface ViewportSample {
  layoutWidth: number;
  layoutHeight: number;
  visualHeight: number;
  visualScale: number;
}

/** A keyboard is at least this much of the height: the address bar of a phone browser (about 56 to 80 px) is not. */
const MIN_SHRINK_PX = 120;
/** ... and at least this fraction of the page, so a tall screen does not take a small change for a keyboard. */
const MIN_SHRINK_FRACTION = 0.2;
/** A page zoomed by more than this has a shorter visual viewport because of the zoom, not a keyboard. */
const ZOOM_TOLERANCE = 1.01;

export function nextBaseline(previous: Baseline | null, layoutWidth: number, layoutHeight: number): Baseline {
  if (previous === null || previous.width !== layoutWidth) return { width: layoutWidth, height: layoutHeight };
  return { width: layoutWidth, height: Math.max(previous.height, layoutHeight) };
}

export function keyboardOpen(sample: ViewportSample, baseline: Baseline): boolean {
  if (sample.visualScale > ZOOM_TOLERANCE) return false;
  // At another width than the one remembered (the phone was turned before the baseline caught up) the layout height is the only height known.
  const closed = sample.layoutWidth === baseline.width ? Math.max(baseline.height, sample.layoutHeight) : sample.layoutHeight;
  const shrink = closed - sample.visualHeight;
  return shrink >= Math.max(MIN_SHRINK_PX, closed * MIN_SHRINK_FRACTION);
}

/** `type`s of an input that bring up no keyboard to type with (a picker, a tick box, a button, a file chooser). */
const NO_KEYBOARD_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "range",
  "color",
  "hidden",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** A control that brings up a keyboard to type with: a text field, a text area, an editable region (not a read-only or disabled one). */
export function isTextEntry(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) return !element.readOnly && !element.disabled && !NO_KEYBOARD_TYPES.has(element.type);
  return element instanceof HTMLElement && (element.isContentEditable === true || ["", "true", "plaintext-only"].includes(element.getAttribute("contenteditable") ?? "no"));
}
