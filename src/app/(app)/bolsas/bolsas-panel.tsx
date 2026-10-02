"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { ContributionView, GoalView, RateReviewView } from "@/features/savings/service";
import {
  computeGoalProgress,
  computeInvestmentReturn,
  formatFxRate,
  formatRatePercent,
  investmentValueCents,
  monthsUntilDeadline,
} from "@/features/savings/math";
import type { FormState } from "@/lib/form-state";
import { dateFormatter } from "@/lib/date";
import { LedgerHistory } from "@/components/ledger-history";
import { formatCents } from "@/lib/money";
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

type BolsaAction = (state: FormState, formData: FormData) => Promise<FormState>;

/** Datalist suggestions for the Moneda field (free-text input on top). */
const COMMON_CURRENCIES = ["USD", "EUR", "USDT", "BRL", "PEN"] as const;

interface Props {
  goals: GoalView[];
  members: { id: string; name: string }[];
  isAdmin: boolean;
  /** The household's base currency (app_config) — what every total is in. */
  baseCurrency: string;
  /** Manual FX rates (F8): base units per 1 foreign unit. */
  fxRates: Record<string, number>;
  patrimony: {
    savingsCents: number;
    investmentsCents: number;
    propertiesCents: number;
    totalCents: number;
  };
  contributionsByGoal: Record<string, ContributionView[]>;
  pendingReviews: RateReviewView[];
  /** Derived ETA copy per goal id (null = nothing to show: no target / inversión). */
  etaLabels: Record<string, string | null>;
  createAction: BolsaAction;
  updateAction: BolsaAction;
  toggleAction: BolsaAction;
  deleteAction: BolsaAction;
  valueAction: BolsaAction;
  contributionAction: BolsaAction;
  markReviewedAction: BolsaAction;
}

/** Where the money is held + how much yield it generated so far. */
function YieldLine({ goal }: { goal: GoalView }) {
  if (goal.institution === null && goal.interestTotalCents <= 0) return null;
  return (
    <p className="text-xs text-muted">
      {goal.institution !== null && <span>Guardado en: {goal.institution}</span>}
      {goal.institution !== null && goal.interestTotalCents > 0 && <span> · </span>}
      {goal.interestTotalCents > 0 && (
        <span className="font-medium text-ink">
          Generó: {formatCents(goal.interestTotalCents)}
        </span>
      )}
    </p>
  );
}

const KIND_LABELS = {
  deposit: "Depósito",
  withdrawal: "Retiro",
} as const;

/**
 * Per-bolsa collapsible history of every ledger entry. Interest rows carry
 * the "Interés" badge and no member attribution; deposit/withdrawal mirrors
 * are NOT listed here — those live in /movimientos.
 */
function HistoryDetails({ entries }: { entries: ContributionView[] }) {
  return (
    <LedgerHistory
      entries={entries}
      emptyLabel="Sin movimientos registrados todavía."
      minusKind="withdrawal"
      kindSlot={(row) => (
        <span className="text-muted">
          {KIND_LABELS[row.kind as keyof typeof KIND_LABELS]}
        </span>
      )}
    />
  );
}

/** Month-granularity deadline copy; helper returns null (no deadline). */
function DeadlineLabel({ deadline }: { deadline: string | null }) {
  const months = monthsUntilDeadline(deadline);
  if (months === null) return null;
  const copy =
    months < 0 ? "plazo vencido" : months === 0 ? "vence este mes" : `vence en ${months} ${months === 1 ? "mes" : "meses"}`;
  return (
    <span
      className={`text-xs ${
        months < 0
          ? "font-medium text-danger-text"
          : "text-muted"
      }`}
    >
      {copy}
    </span>
  );
}

/** Segmented depósito/retiro toggle (radio group styled as a two-option pill). */
function KindToggle({
  value,
  onChange,
}: {
  value: "deposit" | "withdrawal";
  onChange: (value: "deposit" | "withdrawal") => void;
}) {
  const options = [
    { value: "deposit" as const, label: "Depósito" },
    { value: "withdrawal" as const, label: "Retiro" },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-line">
      {options.map((option) => (
        <label
          key={option.value}
          className={`cursor-pointer px-3 py-1.5 text-sm font-medium transition-colors ${
            value === option.value
              ? "bg-ink text-base"
              : "bg-surface text-muted hover:bg-base"
          }`}
        >
          <input
            type="radio"
            name="kind"
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/**
 * Quick contribution: monto first (autoFocused on the first card), Enter
 * saves natively, form resets after success. Explicit microcopy: a deposit
 * leaves the available money; a withdrawal returns as income.
 */
function QuickContributionForm({
  goal,
  action,
  autoFocus,
  tourId,
}: {
  goal: GoalView;
  action: BolsaAction;
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
  const [kind, setKind] = useState<"deposit" | "withdrawal">("deposit");

  return (
    <form action={formAction} data-tour={tourId} className="flex flex-col gap-2 border-t border-line pt-3">
      <input type="hidden" name="id" value={goal.id} />
      <p className="text-xs text-muted">
        {kind === "deposit"
          ? "El depósito sale del dinero disponible (queda registrado como gasto de ahorro)."
          : "El retiro vuelve como ingreso a tu dinero disponible."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <KindToggle value={kind} onChange={setKind} />
        <input
          ref={amountRef}
          name="amount"
          inputMode="decimal"
          placeholder="1.234,56"
          required
          aria-label={`Monto del aporte a ${goal.name}`}
          className={`${inputClass} w-32 flex-1`}
        />
        <SubmitButton pending={pending}>
          {kind === "deposit" ? "Depositar" : "Retirar"}
        </SubmitButton>
      </div>
      <FormError state={state} />
      <OkMessage state={state} text="Aporte registrado." />
    </form>
  );
}

function BolsaCard({
  goal,
  contributionAction,
  autoFocusContribution,
  tourId,
  entries,
  etaLabel,
}: {
  goal: GoalView;
  contributionAction: BolsaAction;
  autoFocusContribution: boolean;
  tourId?: string;
  entries: ContributionView[];
  etaLabel: string | null;
}) {
  const progress = computeGoalProgress(goal.netCents, goal.targetCents);
  return (
    <li
      className={`flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm ${
        goal.isActive ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{goal.name}</span>
        <ScopeBadge scope={goal.scope} memberName={goal.memberName} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RateBadge annualRateBp={goal.annualRateBp} mode={goal.accrualMode === "compound" ? "TEA" : "TNA"} />
      </div>
      {progress ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>
              {formatCents(goal.netCents)} de {formatCents(goal.targetCents!)}
            </span>
            <span className="tabular-nums">{progress.pct}%</span>
          </div>
          <ProgressBar pct={progress.pct} status={progress.status} />
          <span className="text-xs text-muted">
            Faltan {formatCents(progress.remainingCents)}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted">
          Acumulado: {formatCents(goal.netCents)}
        </p>
      )}
      {etaLabel && <p className="text-xs font-medium text-muted">{etaLabel}</p>}
      <YieldLine goal={goal} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DeadlineLabel deadline={goal.deadline} />
        <span className="text-xs text-muted">
          {goal.contributionCount} {goal.contributionCount === 1 ? "aporte" : "aportes"}
        </span>
      </div>
      <HistoryDetails entries={entries} />
      {goal.isActive && (
        <QuickContributionForm
          goal={goal}
          action={contributionAction}
          autoFocus={autoFocusContribution}
          tourId={tourId}
        />
      )}
    </li>
  );
}

/**
 * Foreign-currency pill (F8): "USD · tasa 3.800" when a manual rate exists,
 * "USD · sin tasa" when the patrimony can't convert it yet.
 */
function CurrencyBadge({ currency, rate }: { currency: string; rate?: number }) {
  return (
    <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-ink">
      {currency} · {rate !== undefined ? `tasa ${formatFxRate(rate)}` : "sin tasa"}
    </span>
  );
}

function InvestmentCard({
  goal,
  isAdmin,
  fxRates,
  contributionAction,
  valueAction,
  autoFocusContribution,
  valueTourId,
  entries,
}: {
  goal: GoalView;
  isAdmin: boolean;
  fxRates: Record<string, number>;
  contributionAction: BolsaAction;
  valueAction: BolsaAction;
  autoFocusContribution: boolean;
  valueTourId?: string;
  entries: ContributionView[];
}) {
  const foreign = goal.currency !== "" ? goal.currency : null;
  const rate = foreign !== null ? fxRates[foreign] : undefined;
  const valueCents = investmentValueCents(goal.netCents, goal.currentValueCents);
  // Base goals: value is base. Foreign + rate: return compares against the
  // converted value (mixed units would lie). Foreign sin tasa: unknown — "—".
  const convertedCents =
    foreign !== null && rate !== undefined ? Math.round(valueCents * rate) : null;
  const returnValue =
    foreign === null || convertedCents !== null
      ? computeInvestmentReturn(goal.netCents, convertedCents ?? goal.currentValueCents)
      : null;
  const returnClass =
    returnValue === null
      ? "text-muted"
      : returnValue > 0
        ? "rounded-md bg-sage/40 px-1.5 text-ink"
        : returnValue < 0
          ? "rounded-md bg-danger-fill/50 px-1.5 text-danger-text"
          : "text-muted";

  const [valueState, valueFormAction, valuePending] = useActionState(valueAction, {});

  return (
    <li
      className={`flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm ${
        goal.isActive ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{goal.name}</span>
        <ScopeBadge scope={goal.scope} memberName={goal.memberName} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RateBadge annualRateBp={goal.annualRateBp} mode={goal.accrualMode === "compound" ? "TEA" : "TNA"} />
        {foreign !== null && <CurrencyBadge currency={foreign} rate={rate} />}
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-xs text-muted">Invertido neto</p>
          <p className="font-medium tabular-nums text-ink">
            {formatCents(goal.netCents)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Valor actual</p>
          <p className="font-medium tabular-nums text-ink">
            {foreign !== null ? formatCents(valueCents, foreign) : formatCents(valueCents)}
          </p>
          {convertedCents !== null && (
            <p className="text-xs tabular-nums text-muted">
              ≈ {formatCents(convertedCents)}
            </p>
          )}
        </div>
        <div>
          <p className="text-xs text-muted">Retorno</p>
          <p className={`font-medium tabular-nums ${returnClass}`}>
            {returnValue === null ? "—" : `${returnValue > 0 ? "+" : ""}${returnValue}%`}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Aportes</p>
          <p className="font-medium tabular-nums text-ink">
            {goal.contributionCount}
          </p>
        </div>
      </div>
      <YieldLine goal={goal} />
      {goal.valueUpdatedAt && (
        <p className="text-xs text-muted">
          actualizado {dateFormatter.format(goal.valueUpdatedAt)}
        </p>
      )}
      {isAdmin && goal.isActive && (
        <form
          action={valueFormAction}
          data-tour={valueTourId}
          className="flex flex-wrap items-center gap-2 border-t border-line pt-3"
        >
          <input type="hidden" name="id" value={goal.id} />
          <input
            name="currentValue"
            inputMode="decimal"
            placeholder={`Valor actual${foreign !== null ? ` en ${foreign}` : ""}`}
            aria-label={`Valor actual de ${goal.name}`}
            defaultValue={goal.currentValueCents === null ? undefined : formatCents(goal.currentValueCents, foreign ?? undefined)}
            className={`${inputClass} w-40 flex-1`}
          />
          <SubmitButton pending={valuePending} variant="secondary">
            Actualizar valor
          </SubmitButton>
          <FieldError message={valueState.fieldErrors?.currentValue} />
          <FormError state={valueState} />
          <OkMessage state={valueState} text="Valor actualizado." />
        </form>
      )}
      <HistoryDetails entries={entries} />
      {goal.isActive && (
        <QuickContributionForm
          goal={goal}
          action={contributionAction}
          autoFocus={autoFocusContribution}
        />
      )}
    </li>
  );
}

function BolsaFields({
  state,
  members,
  baseCurrency,
  goal,
}: {
  state: FormState;
  members: { id: string; name: string }[];
  baseCurrency: string;
  goal?: GoalView;
}) {
  const [kind, setKind] = useState<"savings" | "investment">(goal?.kind ?? "savings");
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Nombre</span>
          <input name="name" defaultValue={goal?.name} required maxLength={64} className={inputClass} />
          <FieldError message={state.fieldErrors?.name} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Tipo</span>
          <select
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as "savings" | "investment")}
            className={inputClass}
          >
            <option value="savings">Bolsa de ahorro</option>
            <option value="investment">Inversión (acciones)</option>
          </select>
          <FieldError message={state.fieldErrors?.kind} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Ámbito</span>
          <select name="scope" defaultValue={goal?.scope ?? "common"} className={inputClass}>
            <option value="common">Común</option>
            <option value="individual">Individual</option>
          </select>
          <FieldError message={state.fieldErrors?.scope} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">
            Integrante (solo individuales)
          </span>
          <select name="memberId" defaultValue={goal?.memberId ?? ""} className={inputClass}>
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
      {kind === "savings" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">
              Objetivo (opcional)
            </span>
            <input
              name="target"
              inputMode="decimal"
              placeholder="1.234,56"
              defaultValue={goal?.targetCents != null ? formatCents(goal.targetCents) : undefined}
              className={inputClass}
            />
            <FieldError message={state.fieldErrors?.target} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">
              Fecha límite (opcional)
            </span>
            <input type="date" name="deadline" defaultValue={goal?.deadline ?? undefined} className={inputClass} />
            <FieldError message={state.fieldErrors?.deadline} />
          </label>
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">
            Valor actual (opcional)
          </span>
          <input
            name="currentValue"
            inputMode="decimal"
            placeholder="1.234,56"
            defaultValue={goal?.currentValueCents != null ? formatCents(goal.currentValueCents, goal.currency || undefined) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.currentValue} />
        </label>
      )}
      {kind === "investment" && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Moneda del valor actual</span>
          <input
            name="currency"
            list="bolsa-currency-options"
            defaultValue={goal?.currency ?? ""}
            placeholder={baseCurrency}
            maxLength={3}
            pattern="[A-Za-z]{3}"
            title="Código de 3 letras, ej: USD"
            className={`${inputClass} uppercase`}
          />
          <datalist id="bolsa-currency-options">
            {COMMON_CURRENCIES.map((code) => (
              <option key={code} value={code} />
            ))}
          </datalist>
          <span className="text-xs text-muted">
            Vacío = {baseCurrency} (la moneda de la casa). Con otra moneda, el
            patrimonio convierte con la tasa manual de Configuración.
          </span>
          <FieldError message={state.fieldErrors?.currency} />
        </label>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">¿Dónde se guarda?</span>
          <input
            name="institution"
            maxLength={64}
            placeholder="banco, billetera, fondo…"
            defaultValue={goal?.institution ?? undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.institution} />
        </label>
        {kind === "savings" && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">
                Rentabilidad anual % (opcional)
              </span>
              <input
                name="annualRate"
                inputMode="decimal"
                placeholder="35,5"
                defaultValue={goal?.annualRateBp != null ? formatRatePercent(goal.annualRateBp) : undefined}
                className={inputClass}
              />
              <FieldError message={state.fieldErrors?.annualRate} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Modo de interés</span>
              <select
                name="accrualMode"
                defaultValue={goal?.accrualMode ?? "simple"}
                className={inputClass}
              >
                <option value="simple">Simple — TNA sobre el capital</option>
                <option value="compound">Compuesto — TEA sobre el saldo</option>
              </select>
              <FieldError message={state.fieldErrors?.accrualMode} />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

function CreateBolsaForm({
  action,
  members,
  baseCurrency,
}: {
  action: BolsaAction;
  members: { id: string; name: string }[];
  baseCurrency: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      data-tour="bolsas-crear"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
    >
      <h2 className="font-semibold text-ink">Nueva bolsa</h2>
      <BolsaFields state={state} members={members} baseCurrency={baseCurrency} />
      <FormError state={state} />
      <SubmitButton pending={pending}>Crear bolsa</SubmitButton>
    </form>
  );
}

function EditBolsaForm({
  goal,
  members,
  baseCurrency,
  updateAction,
  toggleAction,
  deleteAction,
}: {
  goal: GoalView;
  members: { id: string; name: string }[];
  baseCurrency: string;
  updateAction: BolsaAction;
  toggleAction: BolsaAction;
  deleteAction: BolsaAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [toggleState, toggleFormAction, togglePending] = useActionState(toggleAction, {});
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});

  return (
    <EditDetails
      summary={
        <>
          <span className={goal.isActive ? "" : "text-muted"}>
            {goal.name}
          </span>
          <ScopeBadge scope={goal.scope} memberName={goal.memberName} />
          <span className="text-sm font-normal text-muted">
            {formatCents(goal.netCents)}
          </span>
          <span className="ml-auto">
            <ActiveBadge active={goal.isActive} />
          </span>
        </>
      }
    >
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={goal.id} />
        <BolsaFields state={state} members={members} baseCurrency={baseCurrency} goal={goal} />
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
      </form>
      <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
        <form action={toggleFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={goal.id} />
          <FormError state={toggleState} />
          <SubmitButton pending={togglePending} variant="secondary">
            {goal.isActive ? "Desactivar" : "Activar"}
          </SubmitButton>
        </form>
        <form action={deleteFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={goal.id} />
          <FormError state={deleteState} />
          <OkMessage state={deleteState} text="Bolsa eliminada." />
          <SubmitButton pending={deletePending} variant="danger">
            Eliminar
          </SubmitButton>
        </form>
      </div>
    </EditDetails>
  );
}

/** Monthly review banner: rate-bearing bolsas not reviewed this month. */
function ReviewBanner({
  pendingReviews,
  isAdmin,
  markReviewedAction,
}: {
  pendingReviews: RateReviewView[];
  isAdmin: boolean;
  markReviewedAction: BolsaAction;
}) {
  const [state, formAction, pending] = useActionState(markReviewedAction, {});
  if (pendingReviews.length === 0) return null;
  return (
    <div
      data-tour="bolsas-revision"
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-honey bg-honey/40 px-5 py-4"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-ink">Revisá la tasa de tus bolsas</p>
        <p className="text-sm text-ink">
          {pendingReviews
            .map((bolsa) => `${bolsa.name} (${formatRatePercent(bolsa.annualRateBp!)}%)`)
            .join(" · ")}
        </p>
      </div>
      {isAdmin && (
        <form action={formAction} className="flex flex-col items-end gap-1">
          <SubmitButton pending={pending} variant="secondary">
            Marcar revisadas
          </SubmitButton>
          <FormError state={state} />
          <OkMessage state={state} text="Bolsas marcadas como revisadas." />
        </form>
      )}
    </div>
  );
}

export default function BolsasPanel({
  goals,
  members,
  isAdmin,
  baseCurrency,
  fxRates,
  patrimony,
  contributionsByGoal,
  pendingReviews,
  etaLabels,
  createAction,
  updateAction,
  toggleAction,
  deleteAction,
  valueAction,
  contributionAction,
  markReviewedAction,
}: Props) {
  const savings = goals.filter((goal) => goal.kind === "savings");
  const investments = goals.filter((goal) => goal.kind === "investment");

  // Patrimony strip honesty note: which foreign currencies actually got
  // converted for the totals above (rate exists). Sorted for stable copy.
  const convertedCurrencies = [...new Set(
    investments
      .filter((goal) => goal.currency !== "" && fxRates[goal.currency] !== undefined)
      .map((goal) => goal.currency),
  )].sort();
  const conversionNote =
    convertedCurrencies.length > 0
      ? `Convierte ${convertedCurrencies
          .map((code) => `${code} ×${formatFxRate(fxRates[code])}`)
          .join(" · ")} a ${baseCurrency}`
      : null;

  // One autoFocus + tour anchor across all cards: the first active goal wins.
  const firstActiveId = goals.find((goal) => goal.isActive)?.id;

  return (
    <div className="flex flex-col gap-6">
      <div
        data-tour="bolsas-patrimonio"
        className="grid gap-4 sm:grid-cols-3"
      >
        {[
          { label: "Patrimonio neto", cents: patrimony.totalCents, accent: true },
          { label: "Ahorro", cents: patrimony.savingsCents, accent: false },
          {
            label: "Inversión",
            cents: patrimony.investmentsCents,
            accent: false,
            note: conversionNote,
          },
          ...(patrimony.propertiesCents > 0
            ? [{ label: "Inmuebles", cents: patrimony.propertiesCents, accent: false, note: null }]
            : []),
        ].map((item) => (
          <article
            key={item.label}
            className={`rounded-2xl border p-5 shadow-sm ${
              item.accent
                ? "border-honey bg-honey/40"
                : "border-line bg-surface"
            }`}
          >
            <h2 className={`text-sm font-medium ${item.accent ? "text-ink" : "text-muted"}`}>
              {item.label}
            </h2>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
              {formatCents(item.cents)}
            </p>
            {item.note && <p className="mt-1 text-xs text-muted">{item.note}</p>}
          </article>
        ))}
      </div>

      <ReviewBanner
        pendingReviews={pendingReviews}
        isAdmin={isAdmin}
        markReviewedAction={markReviewedAction}
      />

      <div data-tour="bolsas-metas" className="flex flex-col gap-3">
        {savings.length > 0 && (
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Bolsas de ahorro
          </h2>
        )}
        <ul className="grid gap-3 sm:grid-cols-2">
          {savings.map((goal) => (
            <BolsaCard
              key={goal.id}
              goal={goal}
              contributionAction={contributionAction}
              autoFocusContribution={goal.id === firstActiveId}
              tourId={goal.id === firstActiveId ? "bolsas-aporte" : undefined}
              entries={contributionsByGoal[goal.id] ?? []}
              etaLabel={etaLabels[goal.id] ?? null}
            />
          ))}
        </ul>

        {investments.length > 0 && (
          <h2 className="mt-2 text-sm font-medium uppercase tracking-wide text-muted">
            Inversiones
          </h2>
        )}
        <ul className="grid gap-3 sm:grid-cols-2">
          {investments.map((goal, index) => (
            <InvestmentCard
              key={goal.id}
              goal={goal}
              isAdmin={isAdmin}
              fxRates={fxRates}
              contributionAction={contributionAction}
              valueAction={valueAction}
              autoFocusContribution={false}
              valueTourId={isAdmin && index === 0 && goal.isActive ? "bolsas-valor" : undefined}
              entries={contributionsByGoal[goal.id] ?? []}
            />
          ))}
        </ul>
        {goals.length === 0 && (
          <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
            Todavía no hay bolsas ni inversiones.
          </p>
        )}
      </div>

      {isAdmin && (
        <>
          <CreateBolsaForm action={createAction} members={members} baseCurrency={baseCurrency} />
          <div className="flex flex-col gap-3">
            {goals.map((goal) => (
              <EditBolsaForm
                key={goal.id}
                goal={goal}
                members={members}
                baseCurrency={baseCurrency}
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
