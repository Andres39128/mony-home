"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
 * on the active one, plus the admin group under a native <details> dropdown.
 * JS enhancement (the details/summary toggle itself works without JS): the
 * dropdown closes on outside clicks, Escape (focus returns to the trigger)
 * and client-side route changes — navigation keeps the same <details> DOM
 * node, whose open state would otherwise persist across routes.
 */
export function TopNavLinks() {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // Synced from the native toggle event, so every open/close path (summary
  // click, setting .open, Escape) updates the summary's aria-expanded.
  const [open, setOpen] = useState(false);

  function close() {
    if (detailsRef.current) detailsRef.current.open = false;
  }

  // Close on route change: the details node survives client-side navigation.
  useEffect(close, [pathname]);

  // While open: outside pointerdown and Escape close the dropdown.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      detailsRef.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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

      <details
        ref={detailsRef}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="relative"
      >
        <summary
          aria-expanded={open}
          className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-full px-3.5 font-medium text-muted transition-colors hover:bg-base hover:text-ink [&::-webkit-details-marker]:hidden"
        >
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
