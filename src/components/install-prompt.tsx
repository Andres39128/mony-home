"use client";

import { useEffect, useState } from "react";
import { XIcon } from "@/components/icons";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
};

const DISMISS_KEY = "pwa-install-dismissed";

/** iPadOS 13+ reports as Mac; disambiguate via touch points. */
function detectIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

/**
 * PWA install affordance, mounted as a row in the mobile "Más" sheet: installs
 * happen on phones, and the sheet is the existing low-noise surface there
 * (desktop users get the browser's own omnibox install entry). Chromium: a
 * saved beforeinstallprompt event is offered via a row button, never
 * auto-prompted. iOS has no such event, so it shows the manual share-sheet
 * instructions. Dismissal lasts for the browsing session (sessionStorage).
 *
 * All browser reads happen while `active` (sheet open) — a client-only,
 * post-hydration moment — so there is no SSR mismatch and no setState in an
 * effect; the effect only wires event listeners.
 */
export function InstallSheetRow({ active }: { active: boolean }) {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  // Bumping forces a re-render so the render-time sessionStorage read below
  // sees the dismissal (we never need the value itself).
  const [, bumpDismissals] = useState(0);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault(); // suppress the browser's own mini-infobar
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!active) return null;

  const dismissed = sessionStorage.getItem(DISMISS_KEY) === "1";
  const installed = window.matchMedia("(display-mode: standalone)").matches;
  if (installed || dismissed) return null;

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, "1");
    bumpDismissals((count) => count + 1);
  }

  function install() {
    void promptEvent?.prompt();
    setPromptEvent(null);
  }

  if (promptEvent) {
    return (
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 hover:bg-base">
        <button
          type="button"
          onClick={install}
          className="flex-1 py-2 text-left text-sm font-medium text-ink"
        >
          Instalar app
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Cerrar sugerencia de instalación"
          className="p-2 text-muted"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    );
  }

  if (detectIOS()) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg px-3 py-2">
        <p className="text-sm leading-snug text-muted">
          Para instalar: tocá <span className="font-medium text-ink">Compartir</span> y
          elegí “Agregar a pantalla de inicio”.
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Cerrar sugerencia de instalación"
          className="p-2 text-muted"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    );
  }

  return null;
}
