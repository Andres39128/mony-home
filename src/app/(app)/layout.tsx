import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/features/auth/session";
import { logoutAction } from "@/features/auth/actions";
import TourLauncher from "@/features/tour/tour-launcher";
import { SparklesIcon } from "@/components/icons";
import { BottomNav } from "@/components/bottom-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { TopNavLinks } from "@/components/top-nav";

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

/** Brand logo. Mobile header and desktop bar share it. */
function AppMark() {
  return (
    <Link href="/" aria-label="mony-home — Ir al inicio">
      <img
        src="/logo-mh.svg"
        alt="Mony Home logo"
        className="size-11 shrink-0 object-contain"
      />
    </Link>
  );
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-full flex-col bg-base font-sans">
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
