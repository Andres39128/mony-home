"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { ContributionView, GoalView, RateReviewView } from "@/features/savings/service";
import {
  computeGoalProgress,
  computeInvestmentReturn,
  formatRatePercent,
  investmentValueCents,
  monthsUntilDeadline,
} from "@/features/savings/math";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
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

type BolsaAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  goals: GoalView[];
  members: { id: string; name: string }[];
  isAdmin: boolean;
  patrimony: { savingsCents: number; investmentsCents: number; totalCents: number };
  contributionsByGoal: Record<string, ContributionView[]>;
  pendingReviews: RateReviewView[];
  createAction: BolsaAction;
  updateAction: BolsaAction;
  toggleAction: BolsaAction;
  deleteAction: BolsaAction;
  valueAction: BolsaAction;
  contributionAction: BolsaAction;
  markReviewedAction: BolsaAction;
}

/** "Común" / "Individual · {member}" badge, same pattern as the other panels. */
function ScopeBadge({ goal }: { goal: GoalView }) {
  return goal.scope === "common" ? (
    <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-ink">
      Común
    </span>
  ) : (
    <span className="rounded-full bg-honey px-2 py-0.5 text-xs font-medium text-ink">
      Individual · {goal.memberName ?? "?"}
    </span>
  );
}

/** Yield badge: annual rate with its mode — TNA (simple) / TEA (compound). */
function RateBadge({ goal }: { goal: GoalView }) {
  if (goal.annualRateBp === null || goal.kind !== "savings") return null;
  return (
    <span className="rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-ink">
      {goal.accrualMode === "compound" ? "TEA" : "TNA"} {formatRatePercent(goal.annualRateBp)}%
    </span>
  );
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
  interest: "Interés",
} as const;

/** Shared es-AR date rendering for ledger rows and valuation stamps. */
const dateFormatter = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Per-bolsa collapsible history of every ledger entry. Interest rows carry
 * the "Interés" badge and no member attribution; deposit/withdrawal mirrors
 * are NOT listed here — those live in /movimientos.
 */
function ContributionHistory({ entries }: { entries: ContributionView[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted">Sin movimientos registrados todavía.</p>;
  }
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
            <span className="text-muted">{KIND_LABELS[entry.kind]}</span>
          )}
          <span className="ml-auto font-medium tabular-nums text-ink">
            {entry.kind === "withdrawal" ? "−" : "+"}
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
function HistoryDetails({ entries }: { entries: ContributionView[] }) {
  return (
    <details className="group border-t border-line pt-3">
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
        <ContributionHistory entries={entries} />
      </div>
    </details>
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
}: {
  goal: GoalView;
  contributionAction: BolsaAction;
  autoFocusContribution: boolean;
  tourId?: string;
  entries: ContributionView[];
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
        <ScopeBadge goal={goal} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RateBadge goal={goal} />
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

function InvestmentCard({
  goal,
  isAdmin,
  contributionAction,
  valueAction,
  autoFocusContribution,
  valueTourId,
  entries,
}: {
  goal: GoalView;
  isAdmin: boolean;
  contributionAction: BolsaAction;
  valueAction: BolsaAction;
  autoFocusContribution: boolean;
  valueTourId?: string;
  entries: ContributionView[];
}) {
  const returnValue = computeInvestmentReturn(goal.netCents, goal.currentValueCents);
  const valueCents = investmentValueCents(goal.netCents, goal.currentValueCents);
  const returnClass =
    returnValue > 0
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
        <ScopeBadge goal={goal} />
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
            {formatCents(valueCents)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Retorno</p>
          <p className={`font-medium tabular-nums ${returnClass}`}>
            {returnValue > 0 ? "+" : ""}
            {returnValue}%
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
            placeholder="Valor actual"
            aria-label={`Valor actual de ${goal.name}`}
            defaultValue={goal.currentValueCents === null ? undefined : formatCents(goal.currentValueCents)}
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
  goal,
}: {
  state: FormState;
  members: { id: string; name: string }[];
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
            defaultValue={goal?.currentValueCents != null ? formatCents(goal.currentValueCents) : undefined}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.currentValue} />
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
}: {
  action: BolsaAction;
  members: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      data-tour="bolsas-crear"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
    >
      <h2 className="font-semibold text-ink">Nueva bolsa</h2>
      <BolsaFields state={state} members={members} />
      <FormError state={state} />
      <SubmitButton pending={pending}>Crear bolsa</SubmitButton>
    </form>
  );
}

function EditBolsaForm({
  goal,
  members,
  updateAction,
  toggleAction,
  deleteAction,
}: {
  goal: GoalView;
  members: { id: string; name: string }[];
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
          <ScopeBadge goal={goal} />
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
        <BolsaFields state={state} members={members} goal={goal} />
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
  patrimony,
  contributionsByGoal,
  pendingReviews,
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
          { label: "Inversión", cents: patrimony.investmentsCents, accent: false },
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
          <CreateBolsaForm action={createAction} members={members} />
          <div className="flex flex-col gap-3">
            {goals.map((goal) => (
              <EditBolsaForm
                key={goal.id}
                goal={goal}
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
