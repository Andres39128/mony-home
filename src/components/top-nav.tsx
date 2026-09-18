"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDownIcon } from "@/components/icons";

const PRIMARY_LINKS = [
  { href: "/", label: "Inicio" },
  { href: "/movimientos", label: "Movimientos" },
  { href: "/bolsas", label: "Bolsas" },
  { href: "/presupuesto", label: "Presupuesto" },
  { href: "/prestamos", label: "Préstamos" },
  { href: "/asistente", label: "Asistente" },
] as const;

const ADMIN_LINKS = [
  { href: "/integrantes", label: "Integrantes" },
  { href: "/categorias", label: "Categorías" },
  { href: "/grupos", label: "Grupos" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * Desktop (md+) top navigation: the 5 primary destinations with an ink pill
 * on the active one, plus the admin group under a native <details> dropdown
 * (no JS; known quirk: it stays open on outside clicks until a selection or
 * a toggle — acceptable for a desktop-only menu).
 */
export function TopNavLinks() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navegación principal"
      className="flex items-center gap-1 text-sm"
    >
      {PRIMARY_LINKS.map(({ href, label }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full px-3.5 font-medium transition-colors ${
              active
                ? "bg-ink text-base"
                : "text-muted hover:bg-base hover:text-ink"
            }`}
          >
            {label}
          </Link>
        );
      })}

      <details className="relative">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-full px-3.5 font-medium text-muted transition-colors hover:bg-base hover:text-ink [&::-webkit-details-marker]:hidden">
          Admin
          <ChevronDownIcon className="size-4" />
        </summary>
        <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          {ADMIN_LINKS.map(({ href, label }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center rounded-lg px-3 text-sm transition-colors ${
                  active
                    ? "bg-base font-semibold text-ink"
                    : "font-medium text-ink hover:bg-base"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </details>
    </nav>
  );
}
