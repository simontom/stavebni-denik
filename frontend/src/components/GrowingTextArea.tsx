import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { TextArea, cn, type TextAreaProps } from "./ui";

/**
 * A text field that is one line high while it is empty and grows with what is written in it (backlog B5), up to a height (16 rem: about
 * ten lines) and then scrolls inside itself. It grows before the browser paints (`useLayoutEffect`), so what is below it never jumps
 * and never moves up while the text above only grows; the page's scroll position is kept. It measures again when the field's width
 * changes (the phone is turned: the lines wrap differently). Nothing moves with an animation, so there is nothing for
 * `prefers-reduced-motion` to switch off. The label, the `name`, the hint and the placeholder are those of a plain `TextArea`.
 */
export function GrowingTextArea({ className, value, ...rest }: TextAreaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const scrolled = window.scrollY;
    el.style.height = "auto";
    const borders = el.offsetHeight - el.clientHeight;
    const wanted = el.scrollHeight + borders;
    el.style.height = `${wanted}px`;
    // the CSS `max-height` stops it; what does not fit then scrolls inside
    el.style.overflowY = wanted > el.offsetHeight + 1 ? "auto" : "hidden";
    if (window.scrollY !== scrolled) window.scrollTo(window.scrollX, scrolled);
  }, []);

  useLayoutEffect(fit, [fit, value]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const watcher = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [fit]);

  return <TextArea ref={ref} rows={1} value={value} className={cn("max-h-64 min-h-11 resize-none overflow-hidden", className)} {...rest} />;
}
