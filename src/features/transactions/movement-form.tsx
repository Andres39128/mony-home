"use client";

import { useEffect, useRef, useState, useActionState, useTransition } from "react";
import type { CategoryView } from "@/features/categories/service";
import type { EnvelopeView } from "@/features/envelopes/service";
import type { ExpenseGroupView } from "@/features/expense-groups/service";
import type { TransactionView } from "@/features/transactions/service";
import type { InlineCategoryState } from "@/features/transactions/actions";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
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
  /** Called after a successful save (edit dialogs close on it). */
  onSuccess?: () => void;
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
    <div className="inline-flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
      {options.map((option) => (
        <label
          key={option.value}
          className={`cursor-pointer px-4 py-2 text-sm font-medium transition-colors ${
            value === option.value
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
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
 * Quick movement entry, shared by the /movimientos dialog, the /movimientos/nuevo
 * fallback page and the per-row edit dialog. Field order per the approved UX
 * spec; Enter submits natively; validation errors come from the server actions.
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
  const [inlineColor, setInlineColor] = useState("#64748b");
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

  function resetForm() {
    setType("expense");
    setScope("common");
    setCategoryId("");
    setEnvelopeId("");
    setGroupId("");
    setMemberId(currentUser.id);
    setInlineOpen(false);
    if (amountRef.current) amountRef.current.value = "";
    if (noteRef.current) noteRef.current.value = "";
    if (dateRef.current) dateRef.current.value = localToday();
  }

  // Post-success behavior lives in the action wrapper (async callback, not an
  // effect): quick entry resets to defaults and confirms; edit dialogs close.
  async function handleMovementAction(prev: FormState, formData: FormData): Promise<FormState> {
    const result = await baseAction(prev, formData);
    if (result.ok) {
      if (mode === "create") resetForm();
      onSuccess?.();
    }
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
        setInlineColor("#64748b");
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

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Tipo</span>
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

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Monto</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Fecha</span>
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

      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Categoría</span>
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
                className="h-9 w-12 shrink-0 cursor-pointer rounded border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-800"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={requestCreateCategory}
                disabled={inlinePending}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Crear categoría
              </button>
              <button
                type="button"
                onClick={() => setInlineOpen(false)}
                className="text-sm text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Bolsa (opcional)</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Integrante</span>
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
              <span className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
                {currentUser.name}
              </span>
            </>
          )}
          <FieldError message={state.fieldErrors?.memberId} />
        </div>      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Ámbito</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Grupo (opcional)</span>
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
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Nota (opcional)</span>
        <input
          ref={noteRef}
          name="note"
          defaultValue={transaction?.note ?? undefined}
          maxLength={200}
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.note} />
      </label>

      <FormError state={state} />
      {mode === "create" && state.ok && (
        <p
          role="status"
          className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
        >
          Movimiento guardado.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {mode === "edit" ? "Guardar cambios" : "Guardar movimiento"}
      </button>
    </form>
  );
}
