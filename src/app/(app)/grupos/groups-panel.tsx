"use client";

import { useActionState } from "react";
import type { ExpenseGroupView } from "@/features/expense-groups/service";
import type { FormState } from "@/lib/form-state";
import {
  EditDetails,
  FieldError,
  FormError,
  OkMessage,
  SubmitButton,
  inputClass,
} from "@/components/forms";

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
    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
      Activo
    </span>
  ) : (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      Cerrado
    </span>
  );
}

function GroupFields({ state, group }: { state: FormState; group?: ExpenseGroupView }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Nombre</span>
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
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Descripción (opcional)</span>
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

function CreateGroupForm({ action }: { action: GroupAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Nuevo grupo</h2>
      <GroupFields state={state} />
      <FormError state={state} />
      <SubmitButton pending={pending}>Crear grupo</SubmitButton>
    </form>
  );
}

function DeleteGroupForm({
  group,
  deleteAction,
}: {
  group: ExpenseGroupView;
  deleteAction: GroupAction;
}) {
  const [state, formAction, pending] = useActionState(deleteAction, {});
  return (
    <form
      action={formAction}
      // Without JS the handler never runs and deletion still works.
      onSubmit={(event) => {
        if (!window.confirm("Los movimientos quedarán sin grupo. ¿Eliminar de todos modos?")) {
          event.preventDefault();
        }
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="id" value={group.id} />
      <FormError state={state} />
      <OkMessage state={state} text="Grupo eliminado." />
      <SubmitButton pending={pending} variant="danger">
        Eliminar
      </SubmitButton>
    </form>
  );
}

function GroupRow({
  group,
  updateAction,
  statusAction,
  deleteAction,
}: {
  group: ExpenseGroupView;
  updateAction: GroupAction;
  statusAction: GroupAction;
  deleteAction: GroupAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [statusState, statusFormAction, statusPending] = useActionState(statusAction, {});

  return (
    <li>
      <EditDetails
        summary={
          <>
            <span>{group.name}</span>
            <StatusBadge status={group.status} />
            <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
              {group.transactionCount} {group.transactionCount === 1 ? "movimiento" : "movimientos"}
            </span>
          </>
        }
      >
        {group.description && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{group.description}</p>
        )}
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={group.id} />
          <GroupFields state={state} group={group} />
          <FormError state={state} />
          <OkMessage state={state} />
          <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
        </form>
        <div className="flex flex-wrap items-start gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <form action={statusFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={group.id} />
            <input type="hidden" name="status" value={group.status === "active" ? "closed" : "active"} />
            <FormError state={statusState} />
            <SubmitButton pending={statusPending} variant="secondary">
              {group.status === "active" ? "Cerrar grupo" : "Reabrir grupo"}
            </SubmitButton>
          </form>
          <DeleteGroupForm group={group} deleteAction={deleteAction} />
        </div>
      </EditDetails>
    </li>
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
  return (
    <div className="flex flex-col gap-6">
      {groups.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Todavía no hay grupos creados.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) =>
            isAdmin ? (
              <GroupRow
                key={group.id}
                group={group}
                updateAction={updateAction}
                statusAction={statusAction}
                deleteAction={deleteAction}
              />
            ) : (
              <li
                key={group.id}
                className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-6 py-4 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="font-medium text-zinc-900 dark:text-zinc-50">{group.name}</span>
                <StatusBadge status={group.status} />
                <span className="text-zinc-500 dark:text-zinc-400">
                  {group.transactionCount} {group.transactionCount === 1 ? "movimiento" : "movimientos"}
                </span>
                {group.description && (
                  <span className="text-zinc-500 dark:text-zinc-400">· {group.description}</span>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      <CreateGroupForm action={createAction} />
    </div>
  );
}
