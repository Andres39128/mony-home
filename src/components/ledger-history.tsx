"use client";

/**
 * Shared collapsible ledger history for the savings (bolsas) and loans
 * panels: ONE <details> wrapper plus ONE row skeleton — date, kind element,
 * signed amount, member/note — with slots for the pieces that legitimately
 * differ between the two screens (empty-state copy, per-kind chips, admin
 * remove buttons, tour anchor).
 */

import type { ReactNode } from "react";
import { asLocalDate, dateFormatter } from "@/lib/date";
import { formatCents } from "@/lib/money";

/** Structural subset shared by ContributionView and PaymentView. */
export interface LedgerRow {
  id: string;
  kind: string;
  amountCents: number;
  date: string;
  note: string | null;
  memberName: string | null;
}

interface LedgerHistoryProps {
  entries: LedgerRow[];
  /** Empty-state copy when this ledger has no rows yet. */
  emptyLabel: string;
  /** The kind that renders with a "−" sign (money back to the pocket). */
  minusKind: string;
  /** Mid-row element for every non-interest kind (label span / charge pill). */
  kindSlot: (row: LedgerRow) => ReactNode;
  /** Optional per-row remove affordance (admin ledger corrections). */
  renderRemove?: (row: LedgerRow) => ReactNode;
  /** Optional data-tour anchor for the guided tour. */
  tourId?: string;
}

export function LedgerHistory({
  entries,
  emptyLabel,
  minusKind,
  kindSlot,
  renderRemove,
  tourId,
}: LedgerHistoryProps) {
  return (
    <details className="group border-t border-line pt-3" data-tour={tourId}>
      <summary className="cursor-pointer list-none text-xs font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="mr-1 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Historial ({entries.length})
      </summary>
      <div className="pt-2">
        {entries.length === 0 ? (
          <p className="text-xs text-muted">{emptyLabel}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="tabular-nums text-muted">
                  {dateFormatter.format(asLocalDate(entry.date))}
                </span>
                {entry.kind === "interest" ? (
                  <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-ink">
                    Interés
                  </span>
                ) : (
                  kindSlot(entry)
                )}
                <span className="ml-auto font-medium tabular-nums text-ink">
                  {entry.kind === minusKind ? "−" : "+"}
                  {formatCents(entry.amountCents)}
                </span>
                <span className="w-full text-xs text-muted sm:w-auto">
                  {entry.memberName ?? entry.note ?? ""}
                </span>
                {renderRemove?.(entry)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
