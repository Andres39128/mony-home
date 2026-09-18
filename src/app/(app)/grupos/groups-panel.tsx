"use client";

import { useActionState, useState } from "react";
import type { ExpenseGroupView } from "@/features/expense-groups/service";
import type { FormState } from "@/lib/form-state";
import {
  CreateTrigger,
  FieldError,
  FormError,
  IconDeleteButton,
  IconEditButton,
  OkMessage,
  SubmitButton,
  inputClass,
} from "@/components/forms";
import { Sheet } from "@/components/sheet";

type GroupAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  groups: ExpenseGroupView[];
  isAdmin: boolean;
  createAction: GroupAction;
  updateAction: GroupAction;
  statusAction: GroupAction;
  deleteAction: GroupAction;
}

function StatusBadge({ status }: { status: ExpenseGroupView["status"] }) {
  return status === "active" ? (
    <span className="rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-on-accent">
      Activo
    </span>
  ) : (
    <span className="rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink">
      Cerrado
    </span>
  );
}

function GroupFields({ state, group }: { state: FormState; group?: ExpenseGroupView }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Nombre</span>
        <input
          name="name"
          defaultValue={group?.name}
          required
          maxLength={80}
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.name} />
      </label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
        <span className="font-medium text-muted">Descripción (opcional)</span>
        <textarea
          name="description"
          defaultValue={group?.description ?? ""}
          maxLength={280}
          rows={2}
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.description} />
      </label>
    </div>
  );
}

/** Rendered inside the create Sheet: field names and action are unchanged. */
function CreateGroupForm({ action }: { action: GroupAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <GroupFields state={state} />
      <FormError state={state} />
      <OkMessage state={state} text="Grupo creado." />
      <SubmitButton pending={pending}>Crear grupo</SubmitButton>
    </form>
  );
}

/**
 * Rendered inside the single edit Sheet: update + open/close forms keep their
 * exact field names and server actions. Delete lives on the row.
 */
function EditGroupForm({
  group,
  updateAction,
  statusAction,
}: {
  group: ExpenseGroupView;
  updateAction: GroupAction;
  statusAction: GroupAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [statusState, statusFormAction, statusPending] = useActionState(statusAction, {});

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={group.id} />
        <GroupFields state={state} group={group} />
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
      </form>
      <form action={statusFormAction} className="flex flex-col gap-2 border-t border-line pt-4">
        <input type="hidden" name="id" value={group.id} />
        <input
          type="hidden"
          name="status"
          value={group.status === "active" ? "closed" : "active"}
        />
        <FormError state={statusState} />
        <SubmitButton pending={statusPending} variant="secondary">
          {group.status === "active" ? "Cerrar grupo" : "Reabrir grupo"}
        </SubmitButton>
      </form>
    </div>
  );
}

export default function GroupsPanel({
  groups,
  isAdmin,
  createAction,
  updateAction,
  statusAction,
  deleteAction,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});
  const editing = groups.find((group) => group.id === editingId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      {isAdmin && (
        <CreateTrigger
          label="Nuevo grupo"
          tourId="grupos-crear"
          onClick={() => setCreating(true)}
        />
      )}

      <FormError state={deleteState} />
      <OkMessage state={deleteState} text="Grupo eliminado." />

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink">Todavía no hay grupos</p>
          <p className="max-w-xs text-sm text-muted">
            {isAdmin
              ? "Creá el primero con el botón Nuevo grupo para juntar movimientos por proyecto u objetivo."
              : "Cuando el admin cree grupos, los vas a ver acá."}
          </p>
        </div>
      ) : (
        <ul data-tour="grupos-lista" className="flex flex-col gap-3">
          {groups.map((group) => (
            <li
              key={group.id}
              className={`flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-4 text-sm shadow-sm ${
                group.status === "active" ? "" : "opacity-60"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{group.name}</span>
                <StatusBadge status={group.status} />
                <span className="text-muted">
                  {group.transactionCount}{" "}
                  {group.transactionCount === 1 ? "movimiento" : "movimientos"}
                </span>
              </div>
              {group.description && (
                <p className="text-sm text-muted">{group.description}</p>
              )}
              {isAdmin && (
                <div className="flex justify-end gap-1 border-t border-line pt-1">
                  <IconEditButton
                    label={`Editar ${group.name}`}
                    onClick={() => setEditingId(group.id)}
                  />
                  <IconDeleteButton
                    label={`Eliminar ${group.name}`}
                    confirm="Los movimientos quedarán sin grupo. ¿Eliminar de todos modos?"
                    id={group.id}
                    formAction={deleteFormAction}
                    pending={deletePending}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <>
          <Sheet open={creating} onClose={() => setCreating(false)} title="Nuevo grupo">
            <CreateGroupForm action={createAction} />
          </Sheet>
          <Sheet open={editing !== null} onClose={() => setEditingId(null)} title="Editar grupo">
            {editing && (
              <EditGroupForm
                group={editing}
                updateAction={updateAction}
                statusAction={statusAction}
              />
            )}
          </Sheet>
        </>
      )}
    </div>
  );
}
