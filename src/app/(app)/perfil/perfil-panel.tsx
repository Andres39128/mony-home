"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/form-state";
import { FieldError, FormError, OkMessage, SubmitButton, inputClass } from "@/components/forms";

type ProfileAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  user: { name: string; username: string; role: string };
  /** Humanized es-AR expiry of the current session, or null. */
  sessionExpiry: string | null;
  passwordAction: ProfileAction;
  nameAction: ProfileAction;
}

/**
 * Self-service account panel: read-only profile info, display-name form and
 * change-own-password form (current password required, repeat as typo guard).
 */
export default function PerfilPanel({
  user,
  sessionExpiry,
  passwordAction,
  nameAction,
}: Props) {
  const [passwordState, passwordFormAction, passwordPending] = useActionState(passwordAction, {});
  const [nameState, nameFormAction, namePending] = useActionState(nameAction, {});

  return (
    <div className="flex flex-col gap-6">
      <dl className="flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-4 text-sm shadow-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Nombre</dt>
          <dd className="font-medium text-ink">{user.name}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Usuario</dt>
          <dd className="font-medium text-ink">{user.username}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Rol</dt>
          <dd className="font-medium text-ink">{user.role}</dd>
        </div>
        {sessionExpiry && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Sesión vence</dt>
            <dd className="font-medium text-ink">{sessionExpiry}</dd>
          </div>
        )}
      </dl>

      <form action={nameFormAction} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Cambiar nombre</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Nombre para mostrar</span>
          <input name="name" defaultValue={user.name} required maxLength={80} className={inputClass} />
          <FieldError message={nameState.fieldErrors?.name} />
        </label>
        <FormError state={nameState} />
        <OkMessage state={nameState} />
        <SubmitButton pending={namePending} variant="secondary">
          Guardar nombre
        </SubmitButton>
      </form>

      <form action={passwordFormAction} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm">
        <h2 className="text-sm font-semibold text-ink">Cambiar contraseña</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Contraseña actual</span>
          <input name="currentPassword" type="password" required autoComplete="current-password" className={inputClass} />
          <FieldError message={passwordState.fieldErrors?.currentPassword} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Nueva contraseña</span>
            <input name="newPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password" className={inputClass} />
            <FieldError message={passwordState.fieldErrors?.newPassword} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Repetir nueva contraseña</span>
            <input name="repeatPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password" className={inputClass} />
            <FieldError message={passwordState.fieldErrors?.repeatPassword} />
          </label>
        </div>
        <FormError state={passwordState} />
        <OkMessage state={passwordState} text="Contraseña actualizada." />
        <SubmitButton pending={passwordPending}>Cambiar contraseña</SubmitButton>
      </form>
    </div>
  );
}
