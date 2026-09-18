"use client";

// dep: driver.js — popover product-tour lib; zero deps, ~5KB gzip, MIT.
// stdlib can't anchor popovers to elements with overlay highlighting.
// Rejected: intro.js (~30KB, heavier), shepherd.js (pulls popper).
import "driver.js/dist/driver.css";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import type { Driver } from "driver.js";
import {
  TOUR_AUTO_LAUNCH_ROUTE,
  TOUR_LABELS,
  TOURS,
  TOUR_STORAGE_KEY,
  tourSelector,
  type TourStep,
} from "./registry";

/**
 * Tour state lives at module level: the launcher mounts once in the (app)
 * layout, and only one tour may run at a time. `tourStarting` guards the
 * async window between click and the dynamic import resolving (StrictMode
 * fires effects twice in dev).
 */
let activeDriver: Driver | null = null;
let tourStarting = false;

/**
 * Launch the tour for `steps`. driver.js is imported on demand, so its JS
 * never loads unless a tour actually starts. Steps whose anchor is missing
 * from the DOM (admin-only controls, conditional panels) are filtered out.
 * Marks the tour as seen on any end path: done, close button, Esc or
 * navigation away (the layout unmount cleanup destroys the active tour).
 */
async function startTour(steps: readonly TourStep[]): Promise<void> {
  if (tourStarting || activeDriver) return;
  tourStarting = true;
  try {
    const { driver } = await import("driver.js");
    const anchors = steps.filter((step) => document.querySelector(tourSelector(step)));
    if (anchors.length === 0) return;

    activeDriver = driver({
      steps: anchors.map((step) => ({
        element: tourSelector(step),
        popover: { title: step.title, description: step.description },
      })),
      allowClose: true,
      // Belt and braces: a step can also lose its anchor mid-tour.
      skipMissingElement: true,
      showProgress: true,
      ...TOUR_LABELS,
      onDestroyed: () => {
        try {
          localStorage.setItem(TOUR_STORAGE_KEY, "1");
        } catch {
          // Private mode may block localStorage; the tour still ran fine.
        }
        activeDriver = null;
      },
    });
    activeDriver.drive();
  } finally {
    tourStarting = false;
  }
}

/**
 * "?" entry point shown in the (app) nav on every page: launches the current
 * page's tour. Also auto-launches the dashboard tour on first visit.
 */
export default function TourLauncher() {
  const pathname = usePathname();
  const steps = TOURS[pathname];

  // Route change (or logout) while a tour is open: close it quietly. Any
  // destroy path marks the tour as seen, so it won't nag on return.
  // On "/" this effect also auto-launches the tour on first visit.
  useEffect(() => {
    if (pathname === TOUR_AUTO_LAUNCH_ROUTE) {
      let seen = true;
      try {
        seen = localStorage.getItem(TOUR_STORAGE_KEY) !== null;
      } catch {
        // Without localStorage access, skip the auto-launch ("?" still works).
      }
      if (!seen) void startTour(TOURS[TOUR_AUTO_LAUNCH_ROUTE] ?? []);
    }
    return () => {
      activeDriver?.destroy();
    };
  }, [pathname]);

  return (
    <button
      type="button"
      onClick={() => void startTour(steps ?? [])}
      disabled={!steps}
      title={steps ? "¿Cómo funciona? Recorrido guiado por esta página" : "Esta página no tiene recorrido guiado"}
      aria-label="¿Cómo funciona?"
      className="flex size-8 items-center justify-center rounded-full border border-zinc-300 font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      ?
    </button>
  );
}
