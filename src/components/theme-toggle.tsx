"use client";

import { useLayoutEffect } from "react";

/**
 * Dual-theme toggle. The sun/moon pair is CSS-driven off the html `.dark`
 * class (no React state), so SSR, the anti-FOUC script and this button can
 * never disagree — no hydration risk. useLayoutEffect re-applies the stored
 * class after React's dev StrictMode remount resets <html>; no-op in prod.
 */
export function ThemeToggle() {
  useLayoutEffect(() => {
    try {
      const stored = localStorage.getItem("theme");
      const dark = stored
        ? stored === "dark"
        : window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", dark);
    } catch {
      // Storage unavailable: the anti-FOUC script already applied its best guess.
    }
  }, []);

  function toggle() {
    const dark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      // Private mode: theme still switches for this visit, just not persisted.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Cambiar tema"
      title="Cambiar tema"
      className="inline-flex size-11 items-center justify-center rounded-lg border border-line bg-surface text-ink transition-colors hover:bg-base"
    >
      {/* Sun in dark mode (switch to light), moon in light mode. */}
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="hidden size-5 dark:block"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5 dark:hidden"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
