"use client";

// dep: driver.js — popover product-tour lib; zero deps, ~5KB gzip, MIT.
// stdlib can't anchor popovers to elements with overlay highlighting.
// Rejected: intro.js (~30KB, heavier), shepherd.js (pulls popper).
import "driver.js/dist/driver.css";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import type { Driver } from "driver.js";
import { HelpIcon } from "@/components/icons";
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
      // Steps anchored inside a collapsed <details> (dashboard charts):
      // open ancestor disclosures so the highlight lands on visible UI.
      onHighlightStarted: (element) => {
        for (
          let node = element?.parentElement;
          node;
          node = node.parentElement
        ) {
          if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
        }
      },
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
      className="flex size-11 items-center justify-center rounded-full border border-line font-semibold text-muted transition-colors hover:bg-base disabled:cursor-not-allowed disabled:opacity-40"
    >
      ?
    </button>
  );
}

/**
 * Row-style entry point for the mobile "Más" sheet: same module-level
 * startTour and per-page registry as the "?" button, just full-width.
 */
export function TourSheetRow() {
  const pathname = usePathname();
  const steps = TOURS[pathname];

  return (
    <button
      type="button"
      onClick={() => void startTour(steps ?? [])}
      disabled={!steps}
      title={
        steps
          ? "Recorrido guiado por esta página"
          : "Esta página no tiene recorrido guiado"
      }
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink transition-colors hover:bg-base disabled:cursor-not-allowed disabled:opacity-40"
    >
      <HelpIcon className="size-5 text-muted" />
      Recorrido guiado
    </button>
  );
}
