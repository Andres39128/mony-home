"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { logoutAction } from "@/features/auth/actions";
import { TourSheetRow } from "@/features/tour/tour-launcher";
import {
  ArrowsIcon,
  ChartIcon,
  CreditCardIcon,
  GridIcon,
  HelpIcon,
  HomeIcon,
  LayersIcon,
  LogoutIcon,
  PouchIcon,
  SparklesIcon,
  TagIcon,
  UsersIcon,
} from "@/components/icons";
import { Sheet } from "@/components/sheet";
import { ThemeToggle } from "@/components/theme-toggle";

const TABS = [
  { href: "/", label: "Inicio", Icon: HomeIcon },
  { href: "/movimientos", label: "Movimientos", Icon: ArrowsIcon },
  { href: "/bolsas", label: "Bolsas", Icon: PouchIcon },
  { href: "/presupuesto", label: "Presupuesto", Icon: ChartIcon },
] as const;

const MENU_LINKS = [
  { href: "/prestamos", label: "Préstamos", Icon: CreditCardIcon },
  { href: "/asistente", label: "Asistente", Icon: SparklesIcon },
  { href: "/integrantes", label: "Integrantes", Icon: UsersIcon },
  { href: "/categorias", label: "Categorías", Icon: TagIcon },
  { href: "/grupos", label: "Grupos", Icon: LayersIcon },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const tabClass =
  "flex min-h-14 w-full flex-col items-center justify-center gap-1 px-1 py-1.5";

/**
 * Mobile-only bottom tab bar (hidden md+): 4 destinations + "Más", which
 * opens the bottom sheet with secondary destinations, the page tour, the
 * theme toggle and logout. The sheet dismisses itself on any navigation.
 */
export function BottomNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // Dismiss the sheet on any route change (adjusting state during render,
  // per react.dev/learn/you-might-not-need-an-effect).
  const [renderedPathname, setRenderedPathname] = useState(pathname);
  if (renderedPathname !== pathname) {
    setRenderedPathname(pathname);
    setMenuOpen(false);
  }

  return (
    <>
      <nav
        aria-label="Navegación principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="grid grid-cols-5">
          {TABS.map(({ href, label, Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={tabClass}
                >
                  <span
                    className={`flex size-8 items-center justify-center rounded-full ${
                      active ? "bg-mint-soft text-ink" : "text-muted"
                    }`}
                  >
                    <Icon className="size-6" />
                  </span>
                  <span
                    className={`text-[11px] leading-none ${
                      active ? "font-semibold text-ink" : "text-muted"
                    }`}
                  >
                    {label}
                  </span>
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-haspopup="dialog"
              className={tabClass}
            >
              <span className="flex size-8 items-center justify-center rounded-full text-muted">
                <GridIcon className="size-6" />
              </span>
              <span className="text-[11px] leading-none text-muted">Más</span>
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Más">
        <nav aria-label="Menú adicional" className="flex flex-col gap-1">
          {MENU_LINKS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink transition-colors hover:bg-base"
            >
              <Icon className="size-5 text-muted" />
              {label}
            </Link>
          ))}

          <hr className="my-2 border-line" />

          <TourSheetRow />

          <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-3">
            <span className="flex items-center gap-3 text-sm font-medium text-ink">
              <HelpIcon className="size-5 text-muted" />
              Tema
            </span>
            <ThemeToggle />
          </div>

          <form action={logoutAction}>
            <button
              type="submit"
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink transition-colors hover:bg-base"
            >
              <LogoutIcon className="size-5 text-muted" />
              Cerrar sesión
            </button>
          </form>
        </nav>
      </Sheet>
    </>
  );
}
