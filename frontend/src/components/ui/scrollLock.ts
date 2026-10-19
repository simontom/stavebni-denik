let locks = 0;

/**
 * Stops the page behind a modal dialog from scrolling (a wheel or a swipe over the backdrop would otherwise scroll it, and the
 * dialog would be over some other part of the page when it closes). Counted, so two dialogs open at once keep it locked until
 * the last one is gone. `index.css` gives `html.modal-open` its `overflow: hidden`. Returns the function that lets go.
 */
export function lockScroll(): () => void {
  if (locks++ === 0) document.documentElement.classList.add("modal-open");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) document.documentElement.classList.remove("modal-open");
  };
}
