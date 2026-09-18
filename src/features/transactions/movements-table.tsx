"use client";

import { useActionState, useState } from "react";
import type { TransactionView } from "@/features/transactions/service";
import type { InlineCategoryState } from "@/features/transactions/actions";
import MovementForm, { type MovementAction } from "@/features/transactions/movement-form";
import type { MovementFormOptions } from "@/features/transactions/form-options";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import { FormError } from "@/components/forms";
import { ArrowsIcon, PencilIcon, TrashIcon } from "@/components/icons";
import { Card } from "@/components/card";
import { Sheet } from "@/components/sheet";

interface Props extends MovementFormOptions {
  rows: TransactionView[];
  currentUser: { id: string; name: string; role: "admin" | "member" };
  serverToday: string;
  updateAction: MovementAction;
  deleteAction: MovementAction;
  createCategoryAction: (
    state: InlineCategoryState,
    formData: FormData,
  ) => Promise<InlineCategoryState>;
}

/** '2026-09-17' → '17/09'. */
function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Colored amount chip classes: pastel fill, legible ink/danger text. */
function amountChipClass(type: TransactionView["type"]): string {
  return type === "income" ? "bg-sage/40 text-ink" : "bg-danger-fill/50 text-danger-text";
}

/** Scope chip: Común → mint, Individual → honey (constant across themes). */
function scopeChipClass(scope: TransactionView["scope"]): string {
  return scope === "individual" ? "bg-honey text-ink" : "bg-mint text-ink";
}

/**
 * Editar/Borrar as icon buttons (44px targets) sharing one delete action
 * instance; the confirm guard stays client-side as before.
 */
function RowActions({
  row,
  canEdit,
  onEdit,
  deleteFormAction,
  deletePending,
}: {
  row: TransactionView;
  canEdit: boolean;
  onEdit: () => void;
  deleteFormAction: (formData: FormData) => void;
  deletePending: boolean;
}) {
  if (!canEdit) return <span className="text-xs text-muted">—</span>;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onEdit}
        aria-label="Editar movimiento"
        title="Editar"
        className="inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-base"
      >
        <PencilIcon className="size-5" />
      </button>
      <form
        action={deleteFormAction}
        onSubmit={(event) => {
          if (!window.confirm("¿Borrar este movimiento?")) {
            event.preventDefault();
          }
        }}
      >
        <input type="hidden" name="id" value={row.id} />
        <button
          type="submit"
          disabled={deletePending}
          aria-label="Borrar movimiento"
          title="Borrar"
          className="inline-flex size-11 items-center justify-center rounded-lg text-danger-text transition-colors hover:bg-danger-fill/50 disabled:opacity-50"
        >
          <TrashIcon className="size-5" />
        </button>
      </form>
    </div>
  );
}

/**
 * Movements list with per-row edit (shared prefilled form in a bottom sheet)
 * and delete (native confirm + server-enforced ownership). Below md each
 * movement renders as a card row (no horizontal scroll); md+ keeps the table.
 * Rendering lives client-side so the option lists for the edit sheet travel
 * once, not per row.
 */
export default function MovementsTable({
  rows,
  currentUser,
  categories,
  envelopes,
  members,
  groups,
  serverToday,
  updateAction,
  deleteAction,
  createCategoryAction,
}: Props) {
  const isAdmin = currentUser.role === "admin";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteState, deleteFormAction, deletePending] = useActionState<FormState, FormData>(
    deleteAction,
    {},
  );
  const editing = rows.find((row) => row.id === editingId) ?? null;

  const actionProps = (row: TransactionView) => ({
    row,
    canEdit: isAdmin || row.memberId === currentUser.id,
    onEdit: () => setEditingId(row.id),
    deleteFormAction,
    deletePending,
  });

  return (
    <div className="flex flex-col gap-3">
      <FormError state={deleteState} />

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
          <ArrowsIcon className="size-8 text-muted" />
          <p className="text-sm font-medium text-ink">Todavía no hay movimientos</p>
          <p className="max-w-xs text-sm text-muted">
            Registrá el primero con el botón + o ajustá los filtros del período.
          </p>
        </div>
      ) : (
        <>
          {/* Mobile: card rows inside one card surface. */}
          <Card className="md:hidden">
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-ink">
                        <span
                          aria-hidden
                          className="inline-block size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: row.categoryColor }}
                        />
                        <span className="truncate">{row.categoryName}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {row.memberName} · {shortDate(row.date)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-lg px-2 py-0.5 text-sm font-medium tabular-nums ${amountChipClass(row.type)}`}
                    >
                      {row.type === "income" ? "+" : "−"}
                      {formatCents(row.amountCents)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${scopeChipClass(row.scope)}`}
                    >
                      {row.scope === "individual" ? "Individual" : "Común"}
                    </span>
                    {row.envelopeName && (
                      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                        {row.envelopeName}
                      </span>
                    )}
                    {row.groupName && (
                      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                        {row.groupName}
                      </span>
                    )}
                    {row.note && (
                      <span className="max-w-44 truncate text-xs text-muted">{row.note}</span>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <RowActions {...actionProps(row)} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          {/* md+: dense table with icon actions. */}
          <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-4 py-3 font-medium">Categoría</th>
                  <th className="px-4 py-3 font-medium">Detalle</th>
                  <th className="px-4 py-3 font-medium">Integrante</th>
                  <th className="px-4 py-3 font-medium">Bolsa</th>
                  <th className="px-4 py-3 font-medium">Grupo</th>
                  <th className="px-4 py-3 font-medium">Ámbito</th>
                  <th className="px-4 py-3 text-right font-medium">Monto</th>
                  <th className="px-4 py-3 font-medium">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{shortDate(row.date)}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: row.categoryColor }}
                        />
                        {row.categoryName}
                      </span>
                    </td>
                    <td className="max-w-48 truncate px-4 py-3 text-muted">
                      {row.note ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{row.memberName}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {row.envelopeName ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {row.groupName ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${scopeChipClass(row.scope)}`}
                      >
                        {row.scope === "individual" ? "Individual" : "Común"}
                      </span>
                    </td>
                    <td
                      className={`whitespace-nowrap rounded-lg px-2 py-1 text-right font-medium tabular-nums ${amountChipClass(row.type)}`}
                    >
                      {row.type === "income" ? "+" : "−"}
                      {formatCents(row.amountCents)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <RowActions {...actionProps(row)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Sheet open={editing !== null} onClose={() => setEditingId(null)} title="Editar movimiento">
        {editing && (
          <MovementForm
            mode="edit"
            transaction={editing}
            categories={categories}
            envelopes={envelopes}
            members={members}
            groups={groups}
            currentUser={currentUser}
            serverToday={serverToday}
            createAction={updateAction}
            updateAction={updateAction}
            createCategoryAction={createCategoryAction}
            submitSticky
            onSuccess={() => setEditingId(null)}
          />
        )}
      </Sheet>
    </div>
  );
}
