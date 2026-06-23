"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Mode = "light" | "dark" | "system";

const STORAGE_KEY = "theme-preference";

/**
 * Lightweight theme toggle without next-themes.
 *
 * Persists mode in localStorage. The actual `<html class="dark">`
 * toggle is done both server-side init (inline script in layout.tsx
 * to avoid FOUC) and here on mode change.
 *
 * Note: @base-ui (shadcn primitive) uses `render` prop, not Radix `asChild`.
 */
function applyMode(mode: Mode) {
  const root = document.documentElement;
  const effective =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  root.classList.toggle("dark", effective === "dark");
  root.dataset.theme = effective;
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  const [mounted, setMounted] = useState(false);

  /*
   * We *must* setState in useEffect here because:
   *   - localStorage isn't available during SSR (window doesn't exist)
   *   - `mounted` flag is the standard React pattern to defer
   *     theme-dependent rendering past hydration without mismatch
   *   - There's no callback API from useMounted/useLocalStorage we
   *     could use instead — this hook IS the local store.
   * react-hooks/set-state-in-effect is generally good advice, but
   * this is the exact case it doesn't cover.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMounted(true);
    const stored = (localStorage.getItem(STORAGE_KEY) as Mode | null) ?? "system";
    setMode(stored);

    if (stored === "system") {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyMode("system");
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const choose = (next: Mode) => {
    setMode(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyMode(next);
  };

  // Render placeholder during SSR — avoids hydration mismatch on the
  // icon (light vs dark depends on user preference). Same width as final.
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Přepnout motiv"
        className="inline-flex size-9 items-center justify-center rounded-md text-foreground"
      >
        <Monitor className="size-4" aria-hidden />
      </button>
    );
  }

  const Icon = mode === "dark" ? Moon : mode === "light" ? Sun : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Přepnout motiv"
            className="inline-flex size-9 items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Icon className="size-4" aria-hidden />
          </button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Motiv</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => choose("light")}>
            <Sun className="mr-2 size-4" aria-hidden /> Světlý
            {mode === "light" && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => choose("dark")}>
            <Moon className="mr-2 size-4" aria-hidden /> Tmavý
            {mode === "dark" && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => choose("system")}>
            <Monitor className="mr-2 size-4" aria-hidden /> Systém
            {mode === "system" && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
