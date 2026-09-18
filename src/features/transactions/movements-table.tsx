"use client";

import { useActionState, useState } from "react";
import type { TransactionView } from "@/features/transactions/service";
import type { InlineCategoryState } from "@/features/transactions/actions";
import MovementForm, { type MovementAction } from "@/features/transactions/movement-form";
import type { MovementFormOptions } from "@/features/transactions/form-options";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import { FormError } from "@/components/forms";

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

/**
 * Movements list with per-row edit (shared prefilled form in a dialog) and
 * delete (native confirm + server-enforced ownership). Rendering lives client-
 * side so the option lists for the edit dialog travel once, not per row.
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

  return (
    <div className="flex flex-col gap-3">
      <FormError state={deleteState} />

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
          No hay movimientos para este filtro.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
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
              {rows.map((row) => {
                const canEdit = isAdmin || row.memberId === currentUser.id;
                return (
                  <tr
                    key={row.id}
                    className="border-b border-line last:border-0"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {shortDate(row.date)}
                    </td>
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
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {row.memberName}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {row.envelopeName ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {row.groupName ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          row.scope === "individual"
                            ? "rounded-full bg-honey px-2 py-0.5 text-xs font-medium text-ink"
                            : "rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-ink"
                        }
                      >
                        {row.scope === "individual" ? "Individual" : "Común"}
                      </span>
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums ${
                        row.type === "income"
                          ? "rounded-lg bg-sage/40 text-ink"
                          : "rounded-lg bg-danger-fill/50 text-danger-text"
                      }`}
                    >
                      {row.type === "income" ? "+" : "−"}
                      {formatCents(row.amountCents)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {canEdit ? (
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => setEditingId(row.id)}
                            className="inline-flex min-h-11 items-center text-sm font-medium text-muted underline-offset-2 hover:underline"
                          >
                            Editar
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
                              className="inline-flex min-h-11 items-center rounded-md px-1 text-sm font-medium text-danger-text underline-offset-2 hover:bg-danger-fill/50 hover:underline disabled:opacity-50"
                            >
                              Borrar
                            </button>
                          </form>
                        </div>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <dialog
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          onClose={() => setEditingId(null)}
          className="m-auto max-h-[85vh] w-[44rem] max-w-[92vw] overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl backdrop:bg-black/40"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-ink">Editar movimiento</h2>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              aria-label="Cerrar"
              className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-base"
            >
              ✕
            </button>
          </div>
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
            onSuccess={() => setEditingId(null)}
          />
        </dialog>
      )}
    </div>
  );
}
