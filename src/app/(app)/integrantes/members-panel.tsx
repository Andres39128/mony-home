"use client";

import { useActionState, useState } from "react";
import type { MemberView, MemberFormState } from "@/features/members/service";
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

type MemberAction = (state: MemberFormState, formData: FormData) => Promise<MemberFormState>;

interface Props {
  members: MemberView[];
  isAdmin: boolean;
  createAction: MemberAction;
  updateAction: MemberAction;
  deleteAction: MemberAction;
}

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

/** Rendered inside the create Sheet: field names and action are unchanged. */
function CreateMemberForm({ action }: { action: MemberAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
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
      <OkMessage state={state} text="Integrante creado." />
      <SubmitButton pending={pending}>Crear integrante</SubmitButton>
    </form>
  );
}

/**
 * Rendered inside the single edit Sheet: the update form keeps its exact
 * field names and server action. Delete lives on the row.
 */
function EditMemberForm({
  member,
  updateAction,
}: {
  member: MemberView;
  updateAction: MemberAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});

  return (
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
      <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
    </form>
  );
}

export default function MembersPanel({ members, isAdmin, createAction, updateAction, deleteAction }: Props) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});
  const editing = members.find((member) => member.id === editingId) ?? null;

  const list = (
    <ul className="flex flex-col gap-3">
      {members.map((member) => (
        <li
          key={member.id}
          className={`flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-4 text-sm shadow-sm ${
            member.isActive ? "" : "opacity-60"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-ink">{member.name}</span>
            <span
              className={
                member.isActive
                  ? "rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-on-accent"
                  : "rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink"
              }
            >
              {member.isActive ? "Activo" : "Inactivo"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-muted">
            <span>{ROLE_LABELS[member.role]}</span>
            <span className="text-xs">{member.username}</span>
          </div>
          {isAdmin && (
            <div className="flex justify-end gap-1 border-t border-line pt-1">
              <IconEditButton
                label={`Editar ${member.name}`}
                onClick={() => setEditingId(member.id)}
              />
              <IconDeleteButton
                label={`Eliminar ${member.name}`}
                confirm={`¿Eliminar el integrante "${member.name}"?`}
                id={member.id}
                formAction={deleteFormAction}
                pending={deletePending}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="flex flex-col gap-6">
      {isAdmin && (
        <CreateTrigger
          label="Nuevo integrante"
          tourId="integrantes-crear"
          onClick={() => setCreating(true)}
        />
      )}

      <FormError state={deleteState} />
      <OkMessage state={deleteState} text="Integrante eliminado." />

      {members.length === 0 ? (
        <p className="text-sm text-muted">Todavía no hay integrantes.</p>
      ) : isAdmin ? (
        // Admin-only tour anchor for the row-level pencil actions.
        <div data-tour="integrantes-editar">{list}</div>
      ) : (
        list
      )}

      {isAdmin && (
        <>
          <Sheet open={creating} onClose={() => setCreating(false)} title="Nuevo integrante">
            <CreateMemberForm action={createAction} />
          </Sheet>
          <Sheet
            open={editing !== null}
            onClose={() => setEditingId(null)}
            title="Editar integrante"
          >
            {editing && <EditMemberForm member={editing} updateAction={updateAction} />}
          </Sheet>
        </>
      )}
    </div>
  );
}
