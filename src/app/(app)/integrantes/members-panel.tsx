"use client";

import { useActionState } from "react";
import type { MemberView, MemberFormState } from "@/features/members/service";
import { EditDetails, inputClass } from "@/components/forms";

type MemberAction = (state: MemberFormState, formData: FormData) => Promise<MemberFormState>;

interface Props {
  members: MemberView[];
  isAdmin: boolean;
  createAction: MemberAction;
  updateAction: MemberAction;
  deleteAction: MemberAction;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-danger-text">{message}</p>;
}

function FormError({ state }: { state: MemberFormState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-fill px-3 py-2 text-sm text-danger-text">
      {state.error}
    </p>
  );
}

function OkMessage({ state, text = "Cambios guardados." }: { state: MemberFormState; text?: string }) {
  if (!state.ok) return null;
  return (
    <p role="status" className="rounded-lg bg-sage px-3 py-2 text-sm text-ink">
      {text}
    </p>
  );
}

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

function CreateMemberForm({ action }: { action: MemberAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      data-tour="integrantes-crear"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
    >
      <h2 className="font-semibold text-ink">Nuevo integrante</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Usuario</span>
          <input name="username" required minLength={3} maxLength={32} className={inputClass} />
          <FieldError message={state.fieldErrors?.username} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Nombre</span>
          <input name="name" required maxLength={80} className={inputClass} />
          <FieldError message={state.fieldErrors?.name} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Contraseña</span>
          <input name="password" type="password" required minLength={8} maxLength={128} className={inputClass} />
          <FieldError message={state.fieldErrors?.password} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Rol</span>
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
        className="inline-flex min-h-11 items-center self-start rounded-lg bg-ink px-4 py-2 text-sm font-medium text-base transition-colors hover:bg-ink/90 disabled:opacity-50"
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
          <span className="text-sm font-normal text-muted">
            ({member.username})
          </span>
        </>
      }
    >
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={member.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Nombre</span>
            <input name="name" defaultValue={member.name} required maxLength={80} className={inputClass} />
            <FieldError message={state.fieldErrors?.name} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Rol</span>
            <select name="role" defaultValue={member.role} className={inputClass}>
              <option value="member">Miembro</option>
              <option value="admin">Administrador</option>
            </select>
            <FieldError message={state.fieldErrors?.role} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">
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
              className="size-4 rounded border-line"
            />
            <span className="font-medium text-muted">Activo</span>
          </label>
        </div>
        <FormError state={state} />
        <OkMessage state={state} />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center self-start rounded-lg bg-ink px-4 py-2 text-sm font-medium text-base transition-colors hover:bg-ink/90 disabled:opacity-50"
        >
          Guardar cambios
        </button>
      </form>
      <form action={deleteFormAction} className="border-t border-line pt-4">
        <input type="hidden" name="id" value={member.id} />
        <FormError state={deleteState} />
        <OkMessage state={deleteState} text="Integrante eliminado." />
        <button
          type="submit"
          disabled={deletePending}
          className="inline-flex min-h-11 items-center self-start rounded-lg border border-danger-fill px-4 py-2 text-sm font-medium text-danger-text transition-colors hover:bg-danger-fill/50 disabled:opacity-50"
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
      <table className="w-full overflow-hidden rounded-2xl border border-line bg-surface text-left text-sm shadow-sm">
        <thead className="bg-base text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-6 py-3 font-medium">Nombre</th>
            <th className="px-6 py-3 font-medium">Usuario</th>
            <th className="px-6 py-3 font-medium">Rol</th>
            <th className="px-6 py-3 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {members.map((member) => (
            <tr key={member.id}>
              <td className="px-6 py-3 font-medium text-ink">{member.name}</td>
              <td className="px-6 py-3 text-muted">{member.username}</td>
              <td className="px-6 py-3 text-muted">{ROLE_LABELS[member.role]}</td>
              <td className="px-6 py-3">
                <span
                  className={
                    member.isActive
                      ? "rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-ink"
                      : "rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink"
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
          <div data-tour="integrantes-editar" className="flex flex-col gap-3">
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
