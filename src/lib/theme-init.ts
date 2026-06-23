/**
 * Inline script injected into <head> to set the theme class BEFORE
 * React hydration. Without this the page would flash light first
 * even if the user prefers dark — classic FOUC.
 *
 * Reads:
 *   1. localStorage["theme-preference"] ("light" | "dark" | "system")
 *   2. Fallback: prefers-color-scheme media query
 *
 * Writes:
 *   - document.documentElement.classList toggles "dark"
 *   - data-theme attribute for any non-Tailwind consumers
 *
 * Kept as a separate constant so it can be embedded via
 * `<script dangerouslySetInnerHTML>` in layout.tsx without lint
 * complaining about JSX-in-string and minified at build time.
 */
export const THEME_INIT_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('theme-preference');
    var mode = stored || 'system';
    var effective = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    var root = document.documentElement;
    if (effective === 'dark') root.classList.add('dark');
    root.setAttribute('data-theme', effective);
  } catch (e) {
    // localStorage blocked (Safari private mode etc.) — just default light.
  }
})();
`;
