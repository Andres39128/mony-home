"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { LoanPeriodView, LoanView, PaymentView } from "@/features/loans/service";
import { formatCents } from "@/lib/money";
import type { FormState } from "@/lib/form-state";
import { formatRatePercent } from "@/features/savings/math";
import { ProgressBar } from "@/components/progress";
import { RateBadge, ScopeBadge } from "@/components/badges";
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
  /** Closed-cuota statement breakdowns for bank loans (D5), newest first. */
  periodsByLoan: Record<string, LoanPeriodView[]>;
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

function KindBadge({ loan }: { loan: LoanView }) {
  return (
    <span className="rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink">
      {KIND_LABELS[loan.kind]}
    </span>
  );
}

/** Entity line + how much interest the debt has generated so far. */
function DebtLine({ loan }: { loan: LoanView }) {  return (
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
      {loan.chargesCents > 0 && (
        <>
          {" · "}
          <span>Cargos del período: {formatCents(loan.chargesCents)}</span>
        </>
      )}
      {loan.amortizationMode === "bank" && (
        <>
          {" · "}
          <span>
            Cuota {formatCents(loan.fixedCuotaCents ?? 0)} día {loan.cuotaDay}
            {loan.contractualRateBp !== null &&
              ` · EA cobrada ${formatRatePercent(loan.chargedRateBp ?? 0)}% (pactada ${formatRatePercent(loan.contractualRateBp)}%)`}
          </span>
        </>
      )}
    </p>
  );
}

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
          ) : entry.kind === "charge" ? (
            // Charge rows carry their component in the note — render it as
            // the pill itself (seguros, otros cargos, mora).
            <span className="rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink">
              {entry.note ?? "Cargo"}
            </span>
          ) : (
            <span className="text-muted">Pago</span>
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

/** Short '4 sep' style date for period headers (no year clutter). */
const PERIOD_DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
const asLocalDate = (iso: string): Date => new Date(`${iso}T12:00:00`);

/**
 * One closed cuota's statement breakdown (D5): the five Davivienda sections
 * plus the saldo identity — saldo_after = saldo_before − capital when the
 * payment covers the cuota. Includes the bank-delta disclosure (R2): the
 * daily-compound interest line can drift vs the bank's stated interest;
 * the residual is absorbed operationally by "Ajustar saldo".
 */
function PeriodResumen({ period }: { period: LoanPeriodView }) {
  const { sections } = period;
  const rows: Array<[string, number]> = [
    ["Seguros", sections.segurosCents],
    ["Otros cargos", sections.otrosCargosCents],
    ["Mora", sections.moraCents],
    ["Intereses", sections.interesesCents],
    ["Capital (cuota − componentes)", sections.capitalCents],
  ];
  return (
    <details className="group border-b border-line py-2 last:border-b-0">
      <summary className="cursor-pointer list-none text-sm text-ink hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mr-1 inline-block text-muted transition-transform group-open:rotate-90">
          ▸
        </span>
        Cuota del {PERIOD_DATE.format(asLocalDate(period.endDate))} — {formatCents(period.cuotaCents)}
        <span className="ml-2 text-xs text-muted tabular-nums">
          saldo {formatCents(period.saldoAfterCents)}
        </span>
      </summary>
      <div className="flex flex-col gap-1 pt-2">
        {rows.map(([label, cents]) => (
          <div key={label} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted">{label}</span>
            <span className="tabular-nums text-ink">{formatCents(cents)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted">Pagos del período</span>
          <span className="tabular-nums text-ink">−{formatCents(period.paymentsCents)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs font-medium">
          <span className="text-muted">
            Saldo {PERIOD_DATE.format(asLocalDate(period.startDate))} →{" "}
            {PERIOD_DATE.format(asLocalDate(period.endDate))}
          </span>
          <span className="tabular-nums text-ink">
            {formatCents(period.saldoBeforeCents)} → {formatCents(period.saldoAfterCents)}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          El interés se computa por capitalización diaria efectiva y puede diferir
          del enunciado del banco; la diferencia se absorbe con “Ajustar saldo”.
        </p>
      </div>
    </details>
  );
}

/** Expandable "Resumen del período" per cuota for bank loans (D5). */
function PeriodBreakdown({ periods }: { periods: LoanPeriodView[] }) {
  if (periods.length === 0) return null;
  return (
    <details className="group border-t border-line pt-3">
      <summary className="cursor-pointer list-none text-xs font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="mr-1 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Resumen por cuota ({periods.length})
      </summary>
      <div className="pt-1">
        {periods.map((period) => (
          <PeriodResumen key={period.endDate} period={period} />
        ))}
      </div>
    </details>
  );
}

/**
 * Quick payment: monto first (autoFocused on the first card), Enter saves
 * natively, form resets after success — same philosophy as the quick
 * contribution form on /bolsas.
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
  periods,
}: {
  loan: LoanView;
  paymentAction: LoanAction;
  autoFocusPayment: boolean;
  tourIds?: { card?: string; interest?: string; payment?: string; history?: string };
  entries: PaymentView[];
  periods: LoanPeriodView[];
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
          <ScopeBadge scope={loan.scope} memberName={loan.memberName} />
          <RateBadge annualRateBp={loan.annualRateBp} mode="TNA" />
          {loan.amortizationMode === "bank" && (
            // EA cobrada is an effective annual rate — the TEA badge.
            <RateBadge annualRateBp={loan.chargedRateBp} mode="TEA" />
          )}
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
      {loan.amortizationMode === "bank" && <PeriodBreakdown periods={periods} />}
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

/** Per-millón display: integer ×100.000 basis → "471,32" pesos por millón. */
function formatPerMillon(x100k: number): string {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(x100k / 1e5);
}

/**
 * Bank calibration section (D4) — rendered when the amortization mode is
 * "bank". Fields are free text parsed by the service through the sanctioned
 * money parser; per-millón inputs accept "471,32" (2 decimals — the seeded
 * full-precision rates round to this on edit).
 */
function BankFields({ state, loan }: { state: FormState; loan?: LoanView }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-line/30 p-4">
      <p className="text-xs text-muted">
        Calibración bancaria: la EA cobrada maneja el cálculo; la pactada es solo
        informativa.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">EA cobrada %</span>
          <input
            name="chargedRate"
            inputMode="decimal"
            placeholder="12,95"
            defaultValue={loan?.chargedRateBp != null ? formatRatePercent(loan.chargedRateBp) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.chargedRate} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Tasa pactada % (opcional)</span>
          <input
            name="contractualRate"
            inputMode="decimal"
            placeholder="17,47"
            defaultValue={loan?.contractualRateBp != null ? formatRatePercent(loan.contractualRateBp) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.contractualRate} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Plazo (meses)</span>
          <input
            name="termMonths"
            inputMode="numeric"
            placeholder="228"
            defaultValue={loan?.termMonths ?? undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.termMonths} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Cuota fija</span>
          <input
            name="fixedCuota"
            inputMode="decimal"
            placeholder="2.628.000,00"
            defaultValue={loan?.fixedCuotaCents != null ? formatCents(loan.fixedCuotaCents) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.fixedCuota} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Día de cuota (1–28)</span>
          <input
            name="cuotaDay"
            inputMode="numeric"
            placeholder="25"
            defaultValue={loan?.cuotaDay ?? undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.cuotaDay} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Tasa de mora % (opcional)</span>
          <input
            name="moraRate"
            inputMode="decimal"
            placeholder="36,5"
            defaultValue={loan?.moraRateBp != null ? formatRatePercent(loan.moraRateBp) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.moraRate} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Valor del inmueble</span>
          <input
            name="propertyValue"
            inputMode="decimal"
            placeholder="339.802.600,00"
            defaultValue={loan?.propertyValueCents != null ? formatCents(loan.propertyValueCents) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.propertyValue} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Base asegurada (referencia)</span>
          <input
            name="insuredBase"
            inputMode="decimal"
            placeholder="204.993.414,80"
            defaultValue={loan?.insuredBaseCents != null ? formatCents(loan.insuredBaseCents) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.insuredBase} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Otros cargos por período</span>
          <input
            name="otherCharges"
            inputMode="decimal"
            placeholder="0,00"
            defaultValue={loan?.otherChargesCents != null ? formatCents(loan.otherChargesCents) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.otherCharges} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Seguro de vida $/millón</span>
          <input
            name="lifeRatePerMillon"
            inputMode="decimal"
            placeholder="471,32"
            defaultValue={
              loan?.lifeInsuranceRatePerMillonX100k != null
                ? formatPerMillon(loan.lifeInsuranceRatePerMillonX100k)
                : undefined
            }
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.lifeRatePerMillon} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Seguro de incendio $/millón</span>
          <input
            name="fireRatePerMillon"
            inputMode="decimal"
            placeholder="218,17"
            defaultValue={
              loan?.fireInsuranceRatePerMillonX100k != null
                ? formatPerMillon(loan.fireInsuranceRatePerMillonX100k)
                : undefined
            }
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.fireRatePerMillon} />
        </label>
      </div>
    </div>
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
  // Amortization mode drives the bank section; stateful because the form is
  // otherwise uncontrolled (defaultValue) and the toggle must re-render it.
  const [mode, setMode] = useState<"simple" | "bank">(
    loan?.amortizationMode === "bank" ? "bank" : "simple",
  );
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Modo de amortización</span>
          <select
            name="amortizationMode"
            value={mode}
            onChange={(event) => setMode(event.target.value === "bank" ? "bank" : "simple")}
            className={inputClass}
          >
            <option value="">Rastreador simple (TNA mensual)</option>
            <option value="bank">Bancario (EA diaria + cuota)</option>
          </select>
          <FieldError message={state.fieldErrors?.amortizationMode} />
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
            Tasa anual TNA % (solo modo simple)
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
      {mode === "bank" && <BankFields state={state} loan={loan} />}
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
          <ScopeBadge scope={loan.scope} memberName={loan.memberName} />
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
  periodsByLoan,
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
              periods={loan.amortizationMode === "bank" ? (periodsByLoan[loan.id] ?? []) : []}
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
