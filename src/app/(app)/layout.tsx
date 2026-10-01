import Link from "next/link";
import type { ReactNode } from "react";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { logoutAction } from "@/features/auth/actions";
import { getAppSettings } from "@/lib/app-settings";
import { setDefaultCurrency } from "@/lib/money";
import CurrencyBoot from "@/components/currency-boot";
import TourLauncher from "@/features/tour/tour-launcher";
import { SparklesIcon } from "@/components/icons";
import { BottomNav } from "@/components/bottom-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { TopNavLinks } from "@/components/top-nav";

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

/** Brand mark: line-only house + budget bars (canonical asset:
 *  public/logo-line.svg). Inlined so the ink stroke follows var(--ink)
 *  and stays visible when dark mode inverts the palette. */
function AppMark() {
  return (
    <Link
      href="/"
      aria-label="mony-home — Ir al inicio"
      className="inline-flex shrink-0 text-ink"
    >
      <svg viewBox="0 0 64 64" className="size-11" aria-hidden="true">
        <rect
          x="14.5"
          y="30"
          width="35"
          height="22"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          d="M8.5 30 32 12.5 55.5 30"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M24 45.5v-6"
          fill="none"
          stroke="#a8dadc"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path
          d="M32 45.5v-10"
          fill="none"
          stroke="#ffe5a3"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path
          d="M40 45.5v-11"
          fill="none"
          stroke="#c7e9c0"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
      </svg>
    </Link>
  );
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  // One settings read per request (React cache). The money module keeps the
  // configured currency/locale as its implicit formatting default, so every
  // server-rendered amount follows app_config — and CurrencyBoot below
  // mirrors it on the client before any panel hydrates.
  const settings = await getAppSettings(getDb());
  setDefaultCurrency(settings.currencyCode, settings.locale);

  return (
    <div className="flex min-h-full flex-col bg-base font-sans">
      {/* Must precede {children}: client panels read the money module default
          during hydration and need it already configured. */}
      <CurrencyBoot currencyCode={settings.currencyCode} locale={settings.locale} />
      {/* Mobile header: brand + assistant shortcut + theme. Navigation lives
          in the bottom tab bar; desktop never sees this bar. */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur md:hidden">
        <AppMark />
        <div className="flex items-center">
          <Link
            href="/asistente"
            aria-label="Ir al Asistente"
            title="Asistente"
            className="inline-flex size-11 items-center justify-center rounded-lg text-ink transition-colors hover:bg-base"
          >
            <SparklesIcon className="size-5" />
          </Link>
          <ThemeToggle />
        </div>
      </header>

      {/* Desktop top bar (md+): brand, primary nav, admin dropdown, actions. */}
      <header className="hidden border-b border-line bg-surface md:block">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <AppMark />
            <TopNavLinks />
          </div>
          <div className="flex items-center gap-3 text-sm">
            <TourLauncher />
            <span className="text-muted">
              {user.name} · {ROLE_LABELS[user.role]}
            </span>
            <ThemeToggle />
            <form action={logoutAction}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium text-muted transition-colors hover:bg-base"
              >
                Cerrar sesión
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* pb-28 clears the fixed bottom tab bar (56px + safe area) on mobile. */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 pb-28 md:pb-8">
        {children}
      </main>

      <BottomNav />
    </div>
  );
}
