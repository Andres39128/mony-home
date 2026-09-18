"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Sheet } from "@/components/sheet";
import { ChevronLeftIcon, ChevronRightIcon, FunnelIcon, XIcon } from "@/components/icons";

export interface ActiveFilter {
  /** Query param the filter maps to. */
  param: string;
  /** Human label including the value, e.g. "Categoría: Supermercado". */
  label: string;
  /** URL of the same page minus this param (computed server-side). */
  href: string;
}

interface FiltersSheetProps {
  /** GET target of the enclosed form, e.g. "/movimientos". */
  action: string;
  /** Current month, humanized ("sep 2026"). */
  monthLabel: string;
  prevMonthHref: string;
  nextMonthHref: string;
  activeFilters: ActiveFilter[];
  /** Server-rendered GET form fields; input names must match the query params. */
  children: ReactNode;
  /** Optional data-tour anchor for the compact bar. */
  tourId?: string;
}

/**
 * Compact filter bar for shareable, no-JS GET filtering: a month stepper
 * (‹ sep 2026 ›), a "Filtros" button that opens the full GET form inside a
 * bottom sheet, and removable chips for every active filter (each chip is a
 * plain link to the same URL minus that param).
 */
export default function FiltersSheet({
  action,
  monthLabel,
  prevMonthHref,
  nextMonthHref,
  activeFilters,
  children,
  tourId,
}: FiltersSheetProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div
        data-tour={tourId}
        className="flex items-center justify-between gap-2 rounded-2xl border border-line bg-surface p-2 shadow-sm"
      >
        <div className="flex items-center">
          <Link
            href={prevMonthHref}
            aria-label="Mes anterior"
            className="inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-base"
          >
            <ChevronLeftIcon className="size-5" />
          </Link>
          <span className="min-w-20 text-center text-sm font-medium text-ink">
            {monthLabel}
          </span>
          <Link
            href={nextMonthHref}
            aria-label="Mes siguiente"
            className="inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-base"
          >
            <ChevronRightIcon className="size-5" />
          </Link>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink transition-colors hover:bg-base"
        >
          <FunnelIcon className="size-5 text-muted" />
          Filtros
          {activeFilters.length > 0 && (
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-honey text-[11px] font-semibold text-ink">
              {activeFilters.length}
            </span>
          )}
        </button>
      </div>

      {activeFilters.length > 0 && (
        <ul aria-label="Filtros activos" className="flex flex-wrap gap-2">
          {activeFilters.map((filter) => (
            <li key={filter.param}>
              <Link
                href={filter.href}
                aria-label={`Quitar filtro: ${filter.label}`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-base pl-3 pr-2.5 text-xs font-medium text-ink transition-colors hover:bg-line"
              >
                {filter.label}
                <XIcon className="size-3.5 shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Filtros">
        {/* The GET form travels from the server page as children: names,
            method and action stay exactly the shareable, no-JS contract. */}
        <form method="get" action={action} className="flex flex-col gap-4">
          {children}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="submit"
              className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg bg-ink px-4 text-sm font-medium text-base transition-colors hover:bg-ink/90"
            >
              Aplicar
            </button>
            <Link
              href={action}
              className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-base"
            >
              Limpiar
            </Link>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
