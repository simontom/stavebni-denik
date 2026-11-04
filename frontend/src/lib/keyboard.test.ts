// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTextEntry, keyboardOpen, nextBaseline } from "./keyboard";
import { useKeyboardOpen } from "./useKeyboardOpen";

const sample = (over: Partial<{ layoutWidth: number; layoutHeight: number; visualHeight: number; visualScale: number }> = {}) => ({
  layoutWidth: 360,
  layoutHeight: 780,
  visualHeight: 780,
  visualScale: 1,
  ...over,
});

describe("keyboardOpen: the visual viewport has been shortened by an on-screen keyboard", () => {
  it("is closed while the visual viewport is as high as the page", () => {
    expect(keyboardOpen(sample(), { width: 360, height: 780 })).toBe(false);
  });

  it("is open when the visual viewport lost a keyboard's worth of height (the layout viewport is not resized: iOS, Chrome on Android)", () => {
    expect(keyboardOpen(sample({ visualHeight: 490 }), { width: 360, height: 780 })).toBe(true); // about 290 px of keyboard
    expect(keyboardOpen(sample({ visualHeight: 500 }), { width: 360, height: 780 })).toBe(true);
  });

  it("is open on a phone held sideways, where the keyboard takes about half of the 360 px", () => {
    expect(keyboardOpen(sample({ layoutWidth: 780, layoutHeight: 360, visualHeight: 170 }), { width: 780, height: 360 })).toBe(true);
  });

  it("takes the collapsing address bar of the browser (60 to 80 px) for no keyboard", () => {
    expect(keyboardOpen(sample({ visualHeight: 780 - 56 }), { width: 360, height: 780 })).toBe(false);
    expect(keyboardOpen(sample({ visualHeight: 780 - 80 }), { width: 360, height: 780 })).toBe(false);
    expect(keyboardOpen(sample({ layoutWidth: 780, layoutHeight: 360, visualHeight: 360 - 56 }), { width: 780, height: 360 })).toBe(false);
  });

  it("takes a page that is pinch-zoomed for no keyboard (zooming shortens the visual viewport too)", () => {
    expect(keyboardOpen(sample({ visualHeight: 780 / 2, visualScale: 2 }), { width: 360, height: 780 })).toBe(false);
    expect(keyboardOpen(sample({ visualHeight: 780 / 1.25, visualScale: 1.25 }), { width: 360, height: 780 })).toBe(false);
  });

  it("is open when the layout viewport is resized as well (older Chrome on Android): the remembered height is the one of the closed keyboard", () => {
    // the layout viewport shrank with the keyboard, so it is no longer what the page is compared with
    expect(keyboardOpen(sample({ layoutHeight: 500, visualHeight: 500 }), { width: 360, height: 780 })).toBe(true);
  });

  it("does not take a desktop window dragged a little lower for a keyboard", () => {
    expect(keyboardOpen(sample({ layoutWidth: 1280, layoutHeight: 700, visualHeight: 700 }), { width: 1280, height: 720 })).toBe(false);
  });
});

describe("nextBaseline: the height the page has when no keyboard is open", () => {
  it("starts from the first measurement and keeps the greatest height seen at that width", () => {
    let b = nextBaseline(null, 360, 700);
    expect(b).toEqual({ width: 360, height: 700 });
    b = nextBaseline(b, 360, 780); // the address bar went away
    expect(b).toEqual({ width: 360, height: 780 });
    b = nextBaseline(b, 360, 500); // a keyboard that resizes the layout viewport: the remembered height stays
    expect(b).toEqual({ width: 360, height: 780 });
  });

  it("starts again when the width changes (the phone was turned, the window was resized)", () => {
    const b = nextBaseline({ width: 360, height: 780 }, 780, 360);
    expect(b).toEqual({ width: 780, height: 360 });
  });
});

describe("isTextEntry: a control that brings up a keyboard", () => {
  const make = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  it("is true for text fields, text areas and editable regions", () => {
    for (const html of [
      "<input>",
      '<input type="text">',
      '<input type="number">',
      '<input type="email">',
      '<input type="password">',
      '<input type="search">',
      '<input type="tel">',
      "<textarea></textarea>",
      '<div contenteditable="true"></div>',
    ]) {
      expect(isTextEntry(make(html)), html).toBe(true);
    }
  });

  it("is false for what takes no typing: buttons, tick boxes, file pickers, selects, links", () => {
    for (const html of [
      '<input type="checkbox">',
      '<input type="radio">',
      '<input type="file">',
      '<input type="button">',
      '<input type="submit">',
      '<input type="date">',
      '<input type="range">',
      "<button></button>",
      "<select></select>",
      "<a href='#'>x</a>",
      "<textarea readonly></textarea>",
      "<input disabled>",
    ]) {
      expect(isTextEntry(make(html)), html).toBe(false);
    }
    expect(isTextEntry(null)).toBe(false);
  });
});

/** A visual viewport that a test can resize, the way a keyboard does. */
class FakeVisualViewport extends EventTarget {
  height = 780;
  scale = 1;
  resizeTo(height: number, scale = 1) {
    this.height = height;
    this.scale = scale;
    this.dispatchEvent(new Event("resize"));
  }
}

describe("useKeyboardOpen", () => {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const sizes = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  const originalMatchMedia = window.matchMedia;
  /** The pointer of the device: a finger (the default of these tests, a phone) or a mouse. */
  const pointer = (coarse: boolean) => {
    window.matchMedia = ((query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  };
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 780 });
    pointer(true);
  });
  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
    if (original) Object.defineProperty(window, "visualViewport", original);
    else Reflect.deleteProperty(window, "visualViewport");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: sizes.innerWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: sizes.innerHeight });
  });

  const withViewport = () => {
    const vv = new FakeVisualViewport();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    return vv;
  };

  it("follows the visual viewport: open when it is shortened by a keyboard, closed when it is back", () => {
    const vv = withViewport();
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);
    act(() => vv.resizeTo(480));
    expect(result.current).toBe(true);
    act(() => vv.resizeTo(780));
    expect(result.current).toBe(false);
  });

  it("does not take zooming for a keyboard", () => {
    const vv = withViewport();
    const { result } = renderHook(() => useKeyboardOpen());
    act(() => vv.resizeTo(390, 2));
    expect(result.current).toBe(false);
  });

  it("stops listening when the component goes away", () => {
    const vv = withViewport();
    const { result, unmount } = renderHook(() => useKeyboardOpen());
    unmount();
    act(() => vv.resizeTo(480));
    expect(result.current).toBe(false);
  });

  it("is not fooled by a window dragged lower or a docked developer tools panel: with a mouse a shortened viewport is no keyboard", () => {
    pointer(false);
    const vv = withViewport();
    const { result } = renderHook(() => useKeyboardOpen());
    act(() => vv.resizeTo(480));
    expect(result.current).toBe(false);
  });

  it("without a visual viewport, a finger with the focus in a text field counts as an open keyboard", () => {
    Reflect.deleteProperty(window, "visualViewport");
    const field = document.createElement("input");
    const button = document.createElement("button");
    document.body.append(field, button);
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);
    act(() => field.focus());
    expect(result.current).toBe(true);
    act(() => button.focus());
    expect(result.current).toBe(false);
    field.remove();
    button.remove();
  });

  it("without a visual viewport and with a mouse, focusing a field is not an open keyboard", () => {
    Reflect.deleteProperty(window, "visualViewport");
    pointer(false);
    const field = document.createElement("input");
    document.body.append(field);
    const { result } = renderHook(() => useKeyboardOpen());
    act(() => field.focus());
    expect(result.current).toBe(false);
    field.remove();
  });
});
