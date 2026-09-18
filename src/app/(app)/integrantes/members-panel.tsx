"use client";

import { useActionState } from "react";
import type { MemberView, MemberFormState } from "@/features/members/service";
import { EditDetails } from "@/components/forms";

type MemberAction = (state: MemberFormState, formData: FormData) => Promise<MemberFormState>;

interface Props {
  members: MemberView[];
  isAdmin: boolean;
  createAction: MemberAction;
  updateAction: MemberAction;
  deleteAction: MemberAction;
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:border-zinc-100";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-red-600 dark:text-red-400">{message}</p>;
}

function FormError({ state }: { state: MemberFormState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {state.error}
    </p>
  );
}

function OkMessage({ state, text = "Cambios guardados." }: { state: MemberFormState; text?: string }) {
  if (!state.ok) return null;
  return (
    <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
      {text}
    </p>
  );
}

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

function CreateMemberForm({ action }: { action: MemberAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Nuevo integrante</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Usuario</span>
          <input name="username" required minLength={3} maxLength={32} className={inputClass} />
          <FieldError message={state.fieldErrors?.username} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Nombre</span>
          <input name="name" required maxLength={80} className={inputClass} />
          <FieldError message={state.fieldErrors?.name} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Contraseña</span>
          <input name="password" type="password" required minLength={8} maxLength={128} className={inputClass} />
          <FieldError message={state.fieldErrors?.password} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Rol</span>
          <select name="role" defaultValue="member" className={inputClass}>
            <option value="member">Miembro</option>
            <option value="admin">Administrador</option>
          </select>
          <FieldError message={state.fieldErrors?.role} />
        </label>
      </div>
      <FormError state={state} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Crear integrante
      </button>
    </form>
  );
}

function EditMemberForm({
  member,
  updateAction,
  deleteAction,
}: {
  member: MemberView;
  updateAction: MemberAction;
  deleteAction: MemberAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});

  return (
    <EditDetails
      summary={
        <>
          {member.name}{" "}
          <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
            ({member.username})
          </span>
        </>
      }
    >
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={member.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Nombre</span>
            <input name="name" defaultValue={member.name} required maxLength={80} className={inputClass} />
            <FieldError message={state.fieldErrors?.name} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Rol</span>
            <select name="role" defaultValue={member.role} className={inputClass}>
              <option value="member">Miembro</option>
              <option value="admin">Administrador</option>
            </select>
            <FieldError message={state.fieldErrors?.role} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Nueva contraseña (opcional)
            </span>
            <input name="newPassword" type="password" minLength={8} maxLength={128} className={inputClass} />
            <FieldError message={state.fieldErrors?.newPassword} />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              name="isActive"
              type="checkbox"
              defaultChecked={member.isActive}
              className="size-4 rounded border-zinc-300"
            />
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Activo</span>
          </label>
        </div>
        <FormError state={state} />
        <OkMessage state={state} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Guardar cambios
        </button>
      </form>
      <form action={deleteFormAction} className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <input type="hidden" name="id" value={member.id} />
        <FormError state={deleteState} />
        <OkMessage state={deleteState} text="Integrante eliminado." />
        <button
          type="submit"
          disabled={deletePending}
          className="self-start rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
        >
          Eliminar
        </button>
      </form>
    </EditDetails>
  );
}

export default function MembersPanel({ members, isAdmin, createAction, updateAction, deleteAction }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <table className="w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white text-left text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
          <tr>
            <th className="px-6 py-3 font-medium">Nombre</th>
            <th className="px-6 py-3 font-medium">Usuario</th>
            <th className="px-6 py-3 font-medium">Rol</th>
            <th className="px-6 py-3 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {members.map((member) => (
            <tr key={member.id}>
              <td className="px-6 py-3 font-medium text-zinc-900 dark:text-zinc-50">{member.name}</td>
              <td className="px-6 py-3 text-zinc-600 dark:text-zinc-400">{member.username}</td>
              <td className="px-6 py-3 text-zinc-600 dark:text-zinc-400">{ROLE_LABELS[member.role]}</td>
              <td className="px-6 py-3">
                <span
                  className={
                    member.isActive
                      ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      : "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  }
                >
                  {member.isActive ? "Activo" : "Inactivo"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isAdmin && (
        <>
          <CreateMemberForm action={createAction} />
          <div className="flex flex-col gap-3">
            {members.map((member) => (
              <EditMemberForm
                key={member.id}
                member={member}
                updateAction={updateAction}
                deleteAction={deleteAction}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
