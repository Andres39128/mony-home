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
        <p className="rounded-2xl border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          No hay movimientos para este filtro.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
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
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-300">
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
                    <td className="max-w-48 truncate px-4 py-3 text-zinc-600 dark:text-zinc-300">
                      {row.note ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-300">
                      {row.memberName}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-300">
                      {row.envelopeName ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-300">
                      {row.groupName ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          row.scope === "individual"
                            ? "rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                            : "rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                        }
                      >
                        {row.scope === "individual" ? "Individual" : "Común"}
                      </span>
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums ${
                        row.type === "income"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
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
                            className="text-sm font-medium text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300"
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
                              className="text-sm font-medium text-red-600 underline-offset-2 hover:underline disabled:opacity-50 dark:text-red-400"
                            >
                              Borrar
                            </button>
                          </form>
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>
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
          className="m-auto max-h-[85vh] w-[44rem] max-w-[92vw] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Editar movimiento</h2>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              aria-label="Cerrar"
              className="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
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
