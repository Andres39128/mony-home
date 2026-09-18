"use client";

import { useActionState } from "react";
import type { EnvelopeProgressView, EnvelopeView } from "@/features/envelopes/service";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import { ProgressBar } from "@/components/progress";
import {
  ActiveBadge,
  FieldError,
  FormError,
  OkMessage,
  SubmitButton,
  inputClass,
} from "@/components/forms";

type EnvelopeAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  envelopes: EnvelopeView[];
  progress: EnvelopeProgressView[];
  members: { id: string; name: string }[];
  isAdmin: boolean;
  createAction: EnvelopeAction;
  updateAction: EnvelopeAction;
  toggleAction: EnvelopeAction;
  deleteAction: EnvelopeAction;
}

/** "Común" / "Individual · {member}" badge shown in list and forms. */
function ScopeBadge({ envelope }: { envelope: EnvelopeView }) {
  return envelope.scope === "common" ? (
    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300">
      Común
    </span>
  ) : (
    <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
      Individual · {envelope.memberName ?? "?"}
    </span>
  );
}

function EnvelopeFields({
  state,
  members,
  envelope,
}: {
  state: FormState;
  members: { id: string; name: string }[];
  envelope?: EnvelopeView;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Nombre</span>
        <input
          name="name"
          defaultValue={envelope?.name}
          required
          maxLength={64}
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.name} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Monto mensual</span>
        <input
          name="monthlyAmount"
          defaultValue={envelope ? formatCents(envelope.monthlyAmountCents) : undefined}
          required
          inputMode="decimal"
          placeholder="1.234,56"
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.monthlyAmount} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Tipo</span>
        <select name="scope" defaultValue={envelope?.scope ?? "common"} className={inputClass}>
          <option value="common">Común</option>
          <option value="individual">Individual</option>
        </select>
        <FieldError message={state.fieldErrors?.scope} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Integrante (solo individuales)
        </span>
        <select name="memberId" defaultValue={envelope?.memberId ?? ""} className={inputClass}>
          <option value="">—</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <FieldError message={state.fieldErrors?.memberId} />
      </label>
    </div>
  );
}

function CreateEnvelopeForm({
  action,
  members,
}: {
  action: EnvelopeAction;
  members: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Nueva bolsa</h2>
      <EnvelopeFields state={state} members={members} />
      <FormError state={state} />
      <SubmitButton pending={pending}>Crear bolsa</SubmitButton>
    </form>
  );
}

function EditEnvelopeForm({
  envelope,
  members,
  updateAction,
  toggleAction,
  deleteAction,
}: {
  envelope: EnvelopeView;
  members: { id: string; name: string }[];
  updateAction: EnvelopeAction;
  toggleAction: EnvelopeAction;
  deleteAction: EnvelopeAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [toggleState, toggleFormAction, togglePending] = useActionState(toggleAction, {});
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});

  return (
    <details className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-6 py-4 font-medium text-zinc-900 hover:bg-zinc-50 dark:text-zinc-50 dark:hover:bg-zinc-800/50">
        <span className={envelope.isActive ? "" : "text-zinc-400 dark:text-zinc-500"}>
          {envelope.name}
        </span>
        <ScopeBadge envelope={envelope} />
        <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
          {formatCents(envelope.monthlyAmountCents)}/mes
        </span>
        <span className="ml-auto">
          <ActiveBadge active={envelope.isActive} />
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={envelope.id} />
          <EnvelopeFields state={state} members={members} envelope={envelope} />
          <FormError state={state} />
          <OkMessage state={state} />
          <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
        </form>
        <div className="flex flex-wrap items-start gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <form action={toggleFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={envelope.id} />
            <FormError state={toggleState} />
            <SubmitButton pending={togglePending} variant="secondary">
              {envelope.isActive ? "Desactivar" : "Activar"}
            </SubmitButton>
          </form>
          <form action={deleteFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={envelope.id} />
            <FormError state={deleteState} />
            <OkMessage state={deleteState} text="Bolsa eliminada." />
            <SubmitButton pending={deletePending} variant="danger">
              Eliminar
            </SubmitButton>
          </form>
        </div>
      </div>
    </details>
  );
}

export default function EnvelopesPanel({
  envelopes,
  progress,
  members,
  isAdmin,
  createAction,
  updateAction,
  toggleAction,
  deleteAction,
}: Props) {
  const progressById = new Map(progress.map((row) => [row.id, row]));

  return (
    <div className="flex flex-col gap-6">
      <ul className="grid gap-3 sm:grid-cols-2">
        {envelopes.map((envelope) => {
          const month = progressById.get(envelope.id);
          return (
            <li
              key={envelope.id}
              className={`flex flex-col gap-2 rounded-2xl border border-zinc-200 bg-white px-6 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${
                envelope.isActive ? "" : "opacity-60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-zinc-900 dark:text-zinc-50">{envelope.name}</span>
                <ScopeBadge envelope={envelope} />
              </div>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">
                  {formatCents(envelope.monthlyAmountCents)}/mes
                </span>
                <ActiveBadge active={envelope.isActive} />
              </div>
              {month && (
                <div className="flex flex-col gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  <div className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span>
                      Este mes: {formatCents(month.spentCents)} de{" "}
                      {formatCents(month.plannedCents)}
                    </span>
                    <span className="tabular-nums">{month.pct}%</span>
                  </div>
                  <ProgressBar pct={month.pct} status={month.status} />
                  <span
                    className={`text-xs ${
                      month.remainingCents < 0
                        ? "font-medium text-red-600 dark:text-red-400"
                        : "text-zinc-500 dark:text-zinc-400"
                    }`}
                  >
                    Restante: {formatCents(month.remainingCents)}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {isAdmin && (
        <>
          <CreateEnvelopeForm action={createAction} members={members} />
          <div className="flex flex-col gap-3">
            {envelopes.map((envelope) => (
              <EditEnvelopeForm
                key={envelope.id}
                envelope={envelope}
                members={members}
                updateAction={updateAction}
                toggleAction={toggleAction}
                deleteAction={deleteAction}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
