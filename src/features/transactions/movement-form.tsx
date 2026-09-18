"use client";

import { useEffect, useRef, useState, useActionState, useTransition } from "react";
import type { CategoryView } from "@/features/categories/service";
import type { EnvelopeView } from "@/features/envelopes/service";
import type { ExpenseGroupView } from "@/features/expense-groups/service";
import type { TransactionView } from "@/features/transactions/service";
import type { InlineCategoryState } from "@/features/transactions/actions";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import { FALLBACK_COLOR } from "@/features/analytics/transform";
import { FieldError, FormError, inputClass } from "@/components/forms";

export type MovementAction = (state: FormState, formData: FormData) => Promise<FormState>;
type InlineCategoryAction = (
  state: InlineCategoryState,
  formData: FormData,
) => Promise<InlineCategoryState>;

interface MovementFormProps {
  mode: "create" | "edit";
  /** Edit prefill; undefined in create mode. */
  transaction?: TransactionView;
  categories: CategoryView[];
  envelopes: EnvelopeView[];
  members: { id: string; name: string; isActive: boolean }[];
  groups: ExpenseGroupView[];
  currentUser: { id: string; name: string; role: "admin" | "member" };
  /** SSR fallback for the date field; corrected to the client-local day on mount. */
  serverToday: string;
  createAction: MovementAction;
  updateAction: MovementAction;
  createCategoryAction: InlineCategoryAction;
  /** Called after a successful save (sheets close on it). */
  onSuccess?: () => void;
  /** Pin the submit to the bottom edge of a scrolling sheet. */
  submitSticky?: boolean;
}

const INLINE_CATEGORY = "__new__";

/** Client-local ISO date ('YYYY-MM-DD') — the authoritative "today" for entry. */
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

function envelopeLabel(envelope: Pick<EnvelopeView, "name" | "scope" | "memberName">): string {
  return envelope.scope === "common"
    ? `Común · ${envelope.name}`
    : `Individual · ${envelope.name} (${envelope.memberName ?? "?"})`;
}

/** Segmented radio control (tipo / ámbito) styled as a two-option toggle. */
function Toggle({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-line">
      {options.map((option) => (
        <label
          key={option.value}
          className={`cursor-pointer px-4 py-2 text-sm font-medium transition-colors ${
            value === option.value
              ? "bg-ink text-base"
              : "bg-surface text-muted hover:bg-base"
          }`}
        >
          <input
            type="radio"
            name={name}
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
 * Quick movement entry, shared by the /movimientos sheet, the
 * /movimientos/nuevo fallback page and the per-row edit sheet. Field order
 * per the approved UX spec; Enter submits natively; validation errors come
 * from the server actions.
 */
export default function MovementForm({
  mode,
  transaction,
  categories,
  envelopes,
  members,
  groups,
  currentUser,
  serverToday,
  createAction,
  updateAction,
  createCategoryAction,
  onSuccess,
  submitSticky = false,
}: MovementFormProps) {
  const isAdmin = currentUser.role === "admin";
  const baseAction = mode === "edit" ? updateAction : createAction;
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    handleMovementAction,
    {},
  );

  const [type, setType] = useState<"income" | "expense">(transaction?.type ?? "expense");
  const [scope, setScope] = useState<"individual" | "common">(transaction?.scope ?? "common");
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? "");
  const [envelopeId, setEnvelopeId] = useState(transaction?.envelopeId ?? "");
  const [groupId, setGroupId] = useState(transaction?.groupId ?? "");
  const [memberId, setMemberId] = useState(transaction?.memberId ?? currentUser.id);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [inlineName, setInlineName] = useState("");
  const [inlineColor, setInlineColor] = useState(FALLBACK_COLOR);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlinePending, startInlineTransition] = useTransition();
  const [extraCategories, setExtraCategories] = useState<
    { id: string; name: string; kind: "income" | "expense" }[]
  >([]);

  const amountRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  // Mount: focus the amount and take the user-local "today" (the server date
  // is only an SSR fallback, so swapping the value avoids hydration drift).
  useEffect(() => {
    amountRef.current?.focus();
    if (!transaction && dateRef.current) dateRef.current.value = localToday();
  }, [transaction]);

  // Post-success behavior lives in the action wrapper (async callback, not an
  // effect): the caller closes its sheet (or the /nuevo page's server action
  // redirects), so the form never lingers open after a save.
  async function handleMovementAction(prev: FormState, formData: FormData): Promise<FormState> {
    const result = await baseAction(prev, formData);
    if (result.ok) onSuccess?.();
    return result;
  }

  // Inline category creation runs OUTSIDE the main form (explicit action
  // call): button-formAction routing inside this form proved fragile with
  // useActionState, and a nested <form> is invalid HTML. The created category
  // is kept locally so its <option> exists even if revalidated props lag.
  function requestCreateCategory() {
    const name = inlineName.trim();
    if (name.length === 0) {
      setInlineError("El nombre es obligatorio");
      return;
    }
    const formData = new FormData();
    formData.set("categoryName", name);
    formData.set("categoryColor", inlineColor);
    formData.set("kind", type);
    startInlineTransition(async () => {
      const result = await createCategoryAction({}, formData);
      if (result.ok && result.categoryId) {
        const newCategory = {
          id: result.categoryId,
          name: result.categoryName ?? name,
          kind: type,
        };
        setExtraCategories((prev) => [...prev, newCategory]);
        setCategoryId(newCategory.id);
        setInlineName("");
        setInlineColor(FALLBACK_COLOR);
        setInlineError(null);
        setInlineOpen(false);
      } else {
        setInlineError(
          result.fieldErrors?.name ??
            result.fieldErrors?.color ??
            result.error ??
            "No se pudo crear la categoría.",
        );
      }
    });
  }

  function changeType(next: "income" | "expense") {
    setType(next);
    setCategoryId("");
    setInlineOpen(false);
  }

  // Active options only; an edited movement keeps its (possibly inactive)
  // refs. Categories created inline appear immediately as local extras (the
  // server props may lag one commit) and are deduped once props include them.
  const serverCategoryOptions = categories.filter(
    (category) => category.kind === type && (category.isActive || category.id === categoryId),
  );
  const serverCategoryIds = new Set(serverCategoryOptions.map((category) => category.id));
  const extraCategoryOptions = extraCategories.filter(
    (extra) => extra.kind === type && !serverCategoryIds.has(extra.id),
  );
  const categoryOptions = [
    ...serverCategoryOptions,
    ...extraCategoryOptions.map((extra) => ({
      id: extra.id,
      name: extra.name,
      isActive: true,
    })),
  ];
  const envelopeOptions = envelopes.filter(
    (envelope) => envelope.isActive || envelope.id === envelopeId,
  );
  const groupOptions = groups.filter((group) => group.status === "active" || group.id === groupId);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {mode === "edit" && transaction && <input type="hidden" name="id" value={transaction.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Monto</span>
          <input
            ref={amountRef}
            name="amount"
            defaultValue={transaction ? formatCents(transaction.amountCents) : undefined}
            inputMode="decimal"
            placeholder="1.234,56"
            required
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.amount} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Fecha</span>
          <input
            ref={dateRef}
            type="date"
            name="date"
            defaultValue={transaction?.date ?? serverToday}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.date} />
        </label>
      </div>

      <section className="flex flex-col gap-4 border-t border-line pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Detalles</h3>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted">Tipo</span>
          <Toggle
            name="type"
            value={type}
            onChange={(value) => changeType(value as "income" | "expense")}
            options={[
              { value: "expense", label: "Gasto" },
              { value: "income", label: "Ingreso" },
            ]}
          />
          <FieldError message={state.fieldErrors?.type} />
        </div>

      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Categoría</span>
        {inlineOpen ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                value={inlineName}
                onChange={(event) => setInlineName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    requestCreateCategory();
                  }
                }}
                placeholder="Nombre de la categoría"
                maxLength={64}
                aria-label="Nombre de la categoría"
                className={inputClass}
              />
              <input
                type="color"
                value={inlineColor}
                onChange={(event) => setInlineColor(event.target.value)}
                aria-label="Color de la categoría"
                className="h-9 w-12 shrink-0 cursor-pointer rounded border border-line bg-surface p-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={requestCreateCategory}
                disabled={inlinePending}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-base disabled:opacity-50"
              >
                Crear categoría
              </button>
              <button
                type="button"
                onClick={() => setInlineOpen(false)}
                className="text-sm text-muted underline-offset-2 hover:underline"
              >
                Cancelar
              </button>
            </div>
            <FieldError message={inlineError ?? undefined} />
          </div>
        ) : (
          <select
            name="categoryId"
            value={categoryId}
            onChange={(event) => {
              if (event.target.value === INLINE_CATEGORY) {
                setInlineOpen(true);
              } else {
                setCategoryId(event.target.value);
              }
            }}
            required
            className={inputClass}
          >
            <option value="" disabled>
              Selecciona una categoría…
            </option>
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.isActive ? "" : " (inactiva)"}
              </option>
            ))}
            <option value={INLINE_CATEGORY}>+ Nueva categoría…</option>
          </select>
        )}
        <FieldError message={state.fieldErrors?.categoryId} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Bolsa (opcional)</span>
          <select
            name="envelopeId"
            value={envelopeId}
            onChange={(event) => setEnvelopeId(event.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            {envelopeOptions.map((envelope) => (
              <option key={envelope.id} value={envelope.id}>
                {envelopeLabel(envelope)}
                {envelope.isActive ? "" : " (inactiva)"}
              </option>
            ))}
          </select>
          <FieldError message={state.fieldErrors?.envelopeId} />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Integrante</span>
          {isAdmin ? (
            <select
              name="memberId"
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
              className={inputClass}
              aria-label="Integrante"
            >
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                  {member.isActive ? "" : " (inactivo)"}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input type="hidden" name="memberId" value={currentUser.id} />
              <span className="rounded-lg border border-line bg-base px-3 py-2 text-muted">
                {currentUser.name}
              </span>
            </>
          )}
          <FieldError message={state.fieldErrors?.memberId} />
        </div>      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted">Ámbito</span>
          <Toggle
            name="scope"
            value={scope}
            onChange={(value) => setScope(value as "individual" | "common")}
            options={[
              { value: "individual", label: "Individual" },
              { value: "common", label: "Común" },
            ]}
          />
          <FieldError message={state.fieldErrors?.scope} />
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Grupo (opcional)</span>
          <select
            name="groupId"
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            {groupOptions.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
                {group.status === "active" ? "" : " (cerrado)"}
              </option>
            ))}
          </select>
          <FieldError message={state.fieldErrors?.groupId} />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Nota (opcional)</span>
        <input
          ref={noteRef}
          name="note"
          defaultValue={transaction?.note ?? undefined}
          maxLength={200}
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.note} />
      </label>
      </section>

      <FormError state={state} />
      {/* Success status: only meaningful on the no-JS /movimientos/nuevo page
          (with JS the caller closes the sheet on success). */}
      {mode === "create" && state.ok && (
        <p
          role="status"
          className="rounded-lg bg-sage px-3 py-2 text-sm text-on-accent"
        >
          Movimiento guardado.
        </p>
      )}

      <div
        className={
          submitSticky
            ? "sticky bottom-0 -mx-5 border-t border-line bg-surface px-5 pb-[calc(1.25rem_+_env(safe-area-inset-bottom))] pt-3"
            : undefined
        }
      >
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-ink px-4 text-sm font-medium text-base transition-colors hover:bg-ink/90 disabled:opacity-50"
        >
          {mode === "edit" ? "Guardar cambios" : "Guardar movimiento"}
        </button>
      </div>
    </form>
  );
}
