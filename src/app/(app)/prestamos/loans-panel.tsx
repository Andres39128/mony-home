"use client";

import { useActionState, useEffect, useRef } from "react";
import type { LoanView, PaymentView } from "@/features/loans/service";
import { formatCents } from "@/lib/money";
import type { FormState } from "@/lib/form-state";
import { formatRatePercent } from "@/features/savings/math";
import { ProgressBar } from "@/components/progress";
import {
  ActiveBadge,
  EditDetails,
  FieldError,
  FormError,
  OkMessage,
  SubmitButton,
  inputClass,
} from "@/components/forms";

type LoanAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  loans: LoanView[];
  members: { id: string; name: string }[];
  isAdmin: boolean;
  summary: { debtCents: number; activeCount: number };
  paymentsByLoan: Record<string, PaymentView[]>;
  createAction: LoanAction;
  updateAction: LoanAction;
  toggleAction: LoanAction;
  deleteAction: LoanAction;
  outstandingAction: LoanAction;
  paymentAction: LoanAction;
}

const KIND_LABELS = {
  credit_card: "Tarjeta",
  investment_line: "Libre inversión",
  mortgage: "Hipoteca",
  other: "Otro",
} as const;

/** "Común" / "Individual · {member}" badge, same pattern as the ahorro panel. */
function ScopeBadge({ loan }: { loan: LoanView }) {
  return loan.scope === "common" ? (
    <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-ink">
      Común
    </span>
  ) : (
    <span className="rounded-full bg-honey px-2 py-0.5 text-xs font-medium text-ink">
      Individual · {loan.memberName ?? "?"}
    </span>
  );
}

function KindBadge({ loan }: { loan: LoanView }) {
  return (
    <span className="rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink">
      {KIND_LABELS[loan.kind]}
    </span>
  );
}

function RateBadge({ loan }: { loan: LoanView }) {
  if (loan.annualRateBp === null) return null;
  return (
    <span className="rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-ink">
      TNA {formatRatePercent(loan.annualRateBp)}%
    </span>
  );
}

/** Entity line + how much interest the debt has generated so far. */
function DebtLine({ loan }: { loan: LoanView }) {
  return (
    <p className="text-xs text-muted">
      <span>Entidad: {loan.entity}</span>
      {loan.interestCents > 0 && (
        <>
          {" · "}
          <span>
            Intereses generados:{" "}
            <span className="font-medium tabular-nums text-danger-text">
              {formatCents(loan.interestCents)}
            </span>
          </span>
        </>
      )}
    </p>
  );
}

const KIND_LABELS_HISTORY = {
  payment: "Pago",
  interest: "Interés",
} as const;

/**
 * Per-loan collapsible history of every ledger entry. Interest rows carry
 * the "Interés" badge and no member attribution; payment mirrors are NOT
 * listed here — those live in /movimientos.
 */
function PaymentHistory({ entries }: { entries: PaymentView[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted">Sin pagos registrados todavía.</p>;
  }
  const dateFormatter = new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  // Date-only strings ('YYYY-MM-DD') parse as UTC; pin to local noon so
  // UTC-3 rendering never shifts the day backwards.
  const asLocalDate = (iso: string): Date => new Date(`${iso}T12:00:00`);
  return (
    <ul className="flex flex-col divide-y divide-line">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
          <span className="tabular-nums text-muted">
            {dateFormatter.format(asLocalDate(entry.date))}
          </span>
          {entry.kind === "interest" ? (
            <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-ink">
              Interés
            </span>
          ) : (
            <span className="text-muted">{KIND_LABELS_HISTORY[entry.kind]}</span>
          )}
          <span className="ml-auto font-medium tabular-nums text-ink">
            {entry.kind === "payment" ? "−" : "+"}
            {formatCents(entry.amountCents)}
          </span>
          <span className="w-full text-xs text-muted sm:w-auto">
            {entry.memberName ?? entry.note ?? ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Collapsible wrapper so cards stay compact until the member wants detail. */
function HistoryDetails({
  entries,
  tourId,
}: {
  entries: PaymentView[];
  tourId?: string;
}) {
  return (
    <details className="group border-t border-line pt-3" data-tour={tourId}>
      <summary className="cursor-pointer list-none text-xs font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="mr-1 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Historial ({entries.length})
      </summary>
      <div className="pt-2">
        <PaymentHistory entries={entries} />
      </div>
    </details>
  );
}

/**
 * Quick payment: monto first (autoFocused on the first card), Enter saves
 * natively, form resets after success — same philosophy as the quick
 * contribution form on /ahorro.
 */
function QuickPaymentForm({
  loan,
  action,
  autoFocus,
  tourId,
}: {
  loan: LoanView;
  action: LoanAction;
  autoFocus: boolean;
  tourId?: string;
}) {
  const amountRef = useRef<HTMLInputElement>(null);

  // Mount: focus the monto (explicit ref focus — the autoFocus attribute is
  // an a11y lint violation and fights the page on multi-card grids).
  useEffect(() => {
    if (autoFocus) amountRef.current?.focus();
  }, [autoFocus]);

  async function handleAction(prev: FormState, formData: FormData): Promise<FormState> {
    const result = await action(prev, formData);
    if (result.ok && amountRef.current) amountRef.current.value = "";
    return result;
  }

  const [state, formAction, pending] = useActionState(handleAction, {});

  return (
    <form action={formAction} data-tour={tourId} className="flex flex-col gap-2 border-t border-line pt-3">
      <input type="hidden" name="id" value={loan.id} />
      <p className="text-xs font-medium text-muted">
        Pagar este préstamo — monto y Enter
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={amountRef}
          name="amount"
          inputMode="decimal"
          placeholder="1.234,56"
          required
          aria-label={`Monto del pago de ${loan.name}`}
          className={`${inputClass} w-32 flex-1`}
        />
        <SubmitButton pending={pending}>Pagar</SubmitButton>
      </div>
      <FormError state={state} />
      <OkMessage state={state} text="Pago registrado." />
    </form>
  );
}

function LoanCard({
  loan,
  paymentAction,
  autoFocusPayment,
  tourIds,
  entries,
}: {
  loan: LoanView;
  paymentAction: LoanAction;
  autoFocusPayment: boolean;
  tourIds?: { card?: string; interest?: string; payment?: string; history?: string };
  entries: PaymentView[];
}) {
  return (
    <li
      data-tour={tourIds?.card}
      className={`flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm ${
        loan.isActive ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{loan.name}</span>
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge loan={loan} />
          <ScopeBadge loan={loan} />
          <RateBadge loan={loan} />
        </div>
      </div>
      <div data-tour={tourIds?.interest}>
        <p className="text-xs text-muted">Deuda pendiente</p>
        <p className="text-xl font-semibold tabular-nums text-danger-text">
          {formatCents(Math.max(loan.outstandingCents, 0))}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span>
            Pagado {formatCents(loan.paidCents)} de {formatCents(loan.principalCents)}
          </span>
          <span className="tabular-nums">{loan.paidPct}%</span>
        </div>
        {/* Inverse of savings: progress = how much of the debt is GONE. */}
        <ProgressBar pct={loan.paidPct} status={loan.paidPct >= 100 ? "over" : loan.paidPct >= 75 ? "warn" : "ok"} />
      </div>
      <DebtLine loan={loan} />
      <HistoryDetails entries={entries} tourId={tourIds?.history} />
      {loan.isActive && (
        <QuickPaymentForm
          loan={loan}
          action={paymentAction}
          autoFocus={autoFocusPayment}
          tourId={tourIds?.payment}
        />
      )}
    </li>
  );
}

function LoanFields({
  state,
  members,
  loan,
}: {
  state: FormState;
  members: { id: string; name: string }[];
  loan?: LoanView;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Nombre</span>
          <input name="name" defaultValue={loan?.name} required maxLength={64} className={inputClass} />
          <FieldError message={state.fieldErrors?.name} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Tipo</span>
          <select name="kind" defaultValue={loan?.kind ?? "credit_card"} className={inputClass}>
            <option value="credit_card">Tarjeta de crédito</option>
            <option value="investment_line">Libre inversión</option>
            <option value="mortgage">Hipoteca</option>
            <option value="other">Otro</option>
          </select>
          <FieldError message={state.fieldErrors?.kind} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Entidad</span>
          <input
            name="entity"
            defaultValue={loan?.entity}
            required
            maxLength={64}
            placeholder="banco, tarjeta, financiera…"
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.entity} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Ámbito</span>
          <select name="scope" defaultValue={loan?.scope ?? "common"} className={inputClass}>
            <option value="common">Común</option>
            <option value="individual">Individual</option>
          </select>
          <FieldError message={state.fieldErrors?.scope} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">
            Integrante (solo individuales)
          </span>
          <select name="memberId" defaultValue={loan?.memberId ?? ""} className={inputClass}>
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
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Capital</span>
          <input
            name="principal"
            inputMode="decimal"
            placeholder="1.234,56"
            required
            defaultValue={loan?.principalCents != null ? formatCents(loan.principalCents) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.principal} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">
            Tasa anual TNA % (opcional)
          </span>
          <input
            name="annualRate"
            inputMode="decimal"
            placeholder="35,5"
            defaultValue={loan?.annualRateBp != null ? formatRatePercent(loan.annualRateBp) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.annualRate} />
        </label>
      </div>
    </div>
  );
}

function CreateLoanForm({
  action,
  members,
}: {
  action: LoanAction;
  members: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      data-tour="prestamos-crear"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
    >
      <h2 className="font-semibold text-ink">Nuevo préstamo</h2>
      <LoanFields state={state} members={members} />
      <FormError state={state} />
      <SubmitButton pending={pending}>Crear préstamo</SubmitButton>
    </form>
  );
}

function EditLoanForm({
  loan,
  members,
  updateAction,
  toggleAction,
  deleteAction,
  outstandingAction,
}: {
  loan: LoanView;
  members: { id: string; name: string }[];
  updateAction: LoanAction;
  toggleAction: LoanAction;
  deleteAction: LoanAction;
  outstandingAction: LoanAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [toggleState, toggleFormAction, togglePending] = useActionState(toggleAction, {});
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});
  const [outstandingState, outstandingFormAction, outstandingPending] = useActionState(
    outstandingAction,
    {},
  );

  return (
    <EditDetails
      summary={
        <>
          <span className={loan.isActive ? "" : "text-muted"}>
            {loan.name}
          </span>
          <ScopeBadge loan={loan} />
          <span className="text-sm font-normal text-muted">
            {formatCents(Math.max(loan.outstandingCents, 0))}
          </span>
          <span className="ml-auto">
            <ActiveBadge active={loan.isActive} />
          </span>
        </>
      }
    >
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={loan.id} />
        <LoanFields state={state} members={members} loan={loan} />
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
      </form>
      {/* Balance correction: when the real statement differs from the
          computed outstanding, the delta becomes a visible ledger entry. */}
      <form action={outstandingFormAction} className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <input type="hidden" name="id" value={loan.id} />
        <span className="text-sm font-medium text-muted">Ajustar saldo</span>
        <input
          name="outstanding"
          inputMode="decimal"
          placeholder="Saldo real"
          aria-label={`Saldo real de ${loan.name}`}
          defaultValue={formatCents(Math.max(loan.outstandingCents, 0))}
          className={`${inputClass} w-40 flex-1`}
        />
        <SubmitButton pending={outstandingPending} variant="secondary">
          Ajustar
        </SubmitButton>
        <FieldError message={outstandingState.fieldErrors?.outstanding} />
        <FormError state={outstandingState} />
        <OkMessage state={outstandingState} text="Saldo ajustado." />
      </form>
      <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
        <form action={toggleFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={loan.id} />
          <FormError state={toggleState} />
          <SubmitButton pending={togglePending} variant="secondary">
            {loan.isActive ? "Desactivar" : "Activar"}
          </SubmitButton>
        </form>
        <form action={deleteFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={loan.id} />
          <FormError state={deleteState} />
          <OkMessage state={deleteState} text="Préstamo eliminado." />
          <SubmitButton pending={deletePending} variant="danger">
            Eliminar
          </SubmitButton>
        </form>
      </div>
    </EditDetails>
  );
}

export default function LoansPanel({
  loans,
  members,
  isAdmin,
  summary,
  paymentsByLoan,
  createAction,
  updateAction,
  toggleAction,
  deleteAction,
  outstandingAction,
  paymentAction,
}: Props) {
  // One autoFocus + tour anchors across all cards: the first active loan wins.
  const firstActiveId = loans.find((loan) => loan.isActive)?.id;

  return (
    <div className="flex flex-col gap-6">
      <div data-tour="prestamos-deuda" className="grid gap-4 sm:grid-cols-2">
        <article className="rounded-2xl border border-danger-fill bg-danger-fill/30 p-5 shadow-sm">
          <h2 className="text-sm font-medium text-ink">Deuda total</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-danger-text">
            {formatCents(summary.debtCents)}
          </p>
        </article>
        <article className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <h2 className="text-sm font-medium text-muted">Préstamos activos</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
            {summary.activeCount}
          </p>
        </article>
      </div>

      <div data-tour="prestamos-lista" className="flex flex-col gap-3">
        <ul className="grid gap-3 sm:grid-cols-2">
          {loans.map((loan) => (
            <LoanCard
              key={loan.id}
              loan={loan}
              paymentAction={paymentAction}
              autoFocusPayment={loan.id === firstActiveId}
              tourIds={
                loan.id === firstActiveId
                  ? {
                      card: "prestamos-tarjeta",
                      interest: "prestamos-interes",
                      payment: "prestamos-pago",
                      history: "prestamos-historial",
                    }
                  : undefined
              }
              entries={paymentsByLoan[loan.id] ?? []}
            />
          ))}
        </ul>
        {loans.length === 0 && (
          <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
            Todavía no hay préstamos registrados.
          </p>
        )}
      </div>

      {isAdmin && (
        <>
          <CreateLoanForm action={createAction} members={members} />
          <div className="flex flex-col gap-3">
            {loans.map((loan) => (
              <EditLoanForm
                key={loan.id}
                loan={loan}
                members={members}
                updateAction={updateAction}
                toggleAction={toggleAction}
                deleteAction={deleteAction}
                outstandingAction={outstandingAction}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
