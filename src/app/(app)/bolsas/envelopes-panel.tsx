"use client";

import { useActionState, useState } from "react";
import type { EnvelopeProgressView, EnvelopeView } from "@/features/envelopes/service";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import { ProgressBar } from "@/components/progress";
import {
  ActiveBadge,
  CreateTrigger,
  FieldError,
  FormError,
  IconDeleteButton,
  IconEditButton,
  OkMessage,
  SubmitButton,
  inputClass,
} from "@/components/forms";
import { PouchIcon } from "@/components/icons";
import { Sheet } from "@/components/sheet";

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
    <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-on-accent">
      Común
    </span>
  ) : (
    <span className="rounded-full bg-honey px-2 py-0.5 text-xs font-medium text-on-accent">
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
        <span className="font-medium text-muted">Nombre</span>
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
        <span className="font-medium text-muted">Monto mensual</span>
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
        <span className="font-medium text-muted">Tipo</span>
        <select name="scope" defaultValue={envelope?.scope ?? "common"} className={inputClass}>
          <option value="common">Común</option>
          <option value="individual">Individual</option>
        </select>
        <FieldError message={state.fieldErrors?.scope} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">
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

/** Rendered inside the create Sheet: field names and action are unchanged. */
function CreateEnvelopeForm({
  action,
  members,
}: {
  action: EnvelopeAction;
  members: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <EnvelopeFields state={state} members={members} />
      <FormError state={state} />
      <OkMessage state={state} text="Bolsa creada." />
      <SubmitButton pending={pending}>Crear bolsa</SubmitButton>
    </form>
  );
}

/**
 * Rendered inside the single edit Sheet: update + activate/deactivate forms
 * keep their exact field names and server actions. Delete lives on the row.
 */
function EditEnvelopeForm({
  envelope,
  members,
  updateAction,
  toggleAction,
}: {
  envelope: EnvelopeView;
  members: { id: string; name: string }[];
  updateAction: EnvelopeAction;
  toggleAction: EnvelopeAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [toggleState, toggleFormAction, togglePending] = useActionState(toggleAction, {});

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={envelope.id} />
        <EnvelopeFields state={state} members={members} envelope={envelope} />
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
      </form>
      <form action={toggleFormAction} className="flex flex-col gap-2 border-t border-line pt-4">
        <input type="hidden" name="id" value={envelope.id} />
        <FormError state={toggleState} />
        <SubmitButton pending={togglePending} variant="secondary">
          {envelope.isActive ? "Desactivar" : "Activar"}
        </SubmitButton>
      </form>
    </div>
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
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});
  const editing = envelopes.find((envelope) => envelope.id === editingId) ?? null;

  const list = (
    <ul data-tour="bolsas-lista" className="grid gap-3 sm:grid-cols-2">
      {envelopes.map((envelope) => {
        const month = progressById.get(envelope.id);
        return (
          <li
            key={envelope.id}
            className={`flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm ${
              envelope.isActive ? "" : "opacity-60"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">{envelope.name}</span>
              <ScopeBadge envelope={envelope} />
            </div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted">
                {formatCents(envelope.monthlyAmountCents)}/mes
              </span>
              <ActiveBadge active={envelope.isActive} />
            </div>
            {month && (
              <div className="flex flex-col gap-1.5 border-t border-line pt-2">
                <div className="flex items-center justify-between gap-2 text-xs text-muted">
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
                      ? "font-medium text-danger-text"
                      : "text-muted"
                  }`}
                >
                  Restante: {formatCents(month.remainingCents)}
                </span>
              </div>
            )}
            {isAdmin && (
              <div className="flex justify-end gap-1 border-t border-line pt-1">
                <IconEditButton
                  label={`Editar ${envelope.name}`}
                  onClick={() => setEditingId(envelope.id)}
                />
                <IconDeleteButton
                  label={`Eliminar ${envelope.name}`}
                  confirm={`¿Eliminar la bolsa "${envelope.name}"?`}
                  id={envelope.id}
                  formAction={deleteFormAction}
                  pending={deletePending}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex flex-col gap-6">
      {isAdmin && (
        <CreateTrigger
          label="Nueva bolsa"
          tourId="bolsas-crear"
          onClick={() => setCreating(true)}
        />
      )}

      <FormError state={deleteState} />
      <OkMessage state={deleteState} text="Bolsa eliminada." />

      {envelopes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
          <PouchIcon className="size-8 text-muted" />
          <p className="text-sm font-medium text-ink">Todavía no hay bolsas</p>
          <p className="max-w-xs text-sm text-muted">
            {isAdmin
              ? "Creá la primera con el botón Nueva bolsa para separar la plata del mes."
              : "Cuando se creen bolsas del hogar, las vas a ver acá."}
          </p>
        </div>
      ) : isAdmin ? (
        // Admin-only tour anchor for the row-level pencil actions.
        <div data-tour="bolsas-editar">{list}</div>
      ) : (
        list
      )}

      {isAdmin && (
        <>
          <Sheet open={creating} onClose={() => setCreating(false)} title="Nueva bolsa">
            <CreateEnvelopeForm action={createAction} members={members} />
          </Sheet>
          <Sheet open={editing !== null} onClose={() => setEditingId(null)} title="Editar bolsa">
            {editing && (
              <EditEnvelopeForm
                envelope={editing}
                members={members}
                updateAction={updateAction}
                toggleAction={toggleAction}
              />
            )}
          </Sheet>
        </>
      )}
    </div>
  );
}
