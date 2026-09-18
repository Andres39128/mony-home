"use client";

import { useActionState } from "react";
import type { LoginState } from "@/features/auth/actions";
import { inputClass } from "@/components/forms";

/**
 * Spanish error copy keyed by the server error — generic on purpose:
 * `invalid_credentials` never reveals whether the username exists.
 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Usuario o contraseña incorrectos",
  locked: "Cuenta bloqueada temporalmente",
  inactive: "Cuenta desactivada",
};

export default function LoginForm({
  action,
}: {
  action: (state: LoginState, formData: FormData) => Promise<LoginState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const errorMessage = state.error ? ERROR_MESSAGES[state.error] : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="username" className="text-sm font-medium text-muted">
          Usuario
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          required
          maxLength={64}
          className={inputClass}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium text-muted">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          className={inputClass}
        />
      </div>
      {errorMessage && (
        <p role="alert" className="rounded-lg bg-danger-fill px-3 py-2 text-sm text-danger-text">
          {errorMessage}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 inline-flex min-h-11 items-center justify-center rounded-lg bg-ink px-4 py-2 font-medium text-base transition-colors hover:bg-ink/90 disabled:opacity-50"
      >
        Iniciar sesión
      </button>
    </form>
  );
}
