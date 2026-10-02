"use client";

import { useActionState, useState } from "react";
import type { CategoryView } from "@/features/categories/service";
import type { RecurringView } from "@/features/recurring/service";
import type { CardOption } from "@/features/transactions/form-options";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import { ScopeBadge } from "@/components/badges";
import {
  ActiveBadge,
  CreateTrigger,
  FieldError,
  FormError,
  IconDeleteButton,
  IconEditButton,
  OkMessage,
  SubmitButton,
  Toggle,
  inputClass,
} from "@/components/forms";
import { Sheet } from "@/components/sheet";

type RecurringAction = (state: FormState, formData: FormData) => Promise<FormState>;
type Frequency = "monthly" | "weekly" | "annual";

interface Props {
  recurring: RecurringView[];
  categories: CategoryView[];
  members: { id: string; name: string; isActive: boolean }[];
  /** Active revolving cards offered as payment method for expenses. */
  cards: CardOption[];
  isAdmin: boolean;
  createAction: RecurringAction;
  updateAction: RecurringAction;
  toggleAction: RecurringAction;
  deleteAction: RecurringAction;
}

const DAY_CHOICES = Array.from({ length: 28 }, (_, index) => index + 1);

const DAY_CHIP = "rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink";
const AMOUNT_INCOME = "rounded-lg bg-sage px-2 py-0.5 font-medium text-on-accent";
const AMOUNT_EXPENSE = "rounded-lg bg-danger-fill px-2 py-0.5 font-medium text-on-accent";

const FREQUENCY_LABELS: Record<Frequency, string> = {
  monthly: "Mensual",
  weekly: "Semanal",
  annual: "Anual",
};

/** Fields shared by the create and edit forms. Category options follow the
 * selected type (only matching-kind categories are selectable); the payment
 * method block mirrors the movement form (card = expenses with cards only). */
function RecurringFields({
  state,
  categories,
  members,
  cards,
  recurring,
}: {
  state: FormState;
  categories: CategoryView[];
  members: { id: string; name: string; isActive: boolean }[];
  cards: CardOption[];
  recurring?: RecurringView;
}) {
  const [type, setType] = useState<"income" | "expense">(recurring?.type ?? "expense");
  const [frequency, setFrequency] = useState<Frequency>(recurring?.frequency ?? "monthly");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card">(
    recurring?.paymentMethod ?? "cash",
  );
  const matchingCategories = categories.filter((category) => category.kind === type);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Nombre</span>
        <input
          name="name"
          defaultValue={recurring?.name}
          required
          maxLength={64}
          placeholder="Alquiler, Netflix, sueldo…"
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.name} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Tipo</span>
        <select
          name="type"
          value={type}
          onChange={(event) => setType(event.target.value as "income" | "expense")}
          className={inputClass}
        >
          <option value="expense">Gasto</option>
          <option value="income">Ingreso</option>
        </select>
        <FieldError message={state.fieldErrors?.type} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Monto</span>
        <input
          name="amount"
          inputMode="decimal"
          placeholder="1.234,56"
          required
          defaultValue={
            recurring?.amountCents != null ? formatCents(recurring.amountCents) : undefined
          }
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.amount} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Frecuencia</span>
        <select
          name="frequency"
          value={frequency}
          onChange={(event) => setFrequency(event.target.value as Frequency)}
          className={inputClass}
        >
          <option value="monthly">Mensual</option>
          <option value="weekly">Semanal</option>
          <option value="annual">Anual</option>
        </select>
        <FieldError message={state.fieldErrors?.frequency} />
      </label>
      {frequency === "weekly" ? (
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Día de la semana</span>
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">
            Se registra cada semana, el mismo día en que creaste el recurrente.
          </p>
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">
            {frequency === "annual" ? "Día del aniversario" : "Día del mes"}
          </span>
          <select
            name="dayOfMonth"
            defaultValue={recurring?.dayOfMonth ?? 1}
            className={inputClass}
          >
            {DAY_CHOICES.map((day) => (
              <option key={day} value={day}>
                Día {day} (todos los meses tienen día {day})
              </option>
            ))}
          </select>
          <FieldError message={state.fieldErrors?.dayOfMonth} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Categoría</span>
        <select
          key={type}
          name="categoryId"
          defaultValue={recurring?.categoryId ?? ""}
          required
          className={inputClass}
        >
          <option value="" disabled>
            Elegí una categoría
          </option>
          {matchingCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
              {category.isActive ? "" : " (inactiva)"}
            </option>
          ))}
        </select>
        <FieldError message={state.fieldErrors?.categoryId} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Integrante</span>
        <select name="memberId" defaultValue={recurring?.memberId ?? ""} required className={inputClass}>
          <option value="" disabled>
            Elegí un integrante
          </option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
              {member.isActive ? "" : " (inactivo)"}
            </option>
          ))}
        </select>
        <FieldError message={state.fieldErrors?.memberId} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Ámbito</span>
        <select name="scope" defaultValue={recurring?.scope ?? "common"} className={inputClass}>
          <option value="common">Común</option>
          <option value="individual">Individual</option>
        </select>
        <FieldError message={state.fieldErrors?.scope} />
      </label>
      {/* Medio de pago: card only exists for expenses with cards configured;
          otherwise the cash default rides the hidden inputs. */}
      {type === "expense" && cards.length > 0 ? (
        <>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Medio de pago</span>
            <Toggle
              name="paymentMethod"
              value={paymentMethod}
              onChange={(value) => setPaymentMethod(value as "cash" | "card")}
              options={[
                { value: "cash", label: "Efectivo" },
                { value: "card", label: "Tarjeta" },
              ]}
            />
            <FieldError message={state.fieldErrors?.paymentMethod} />
          </div>
          {paymentMethod === "card" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Tarjeta de crédito</span>
              <select name="cardId" defaultValue={recurring?.cardId ?? ""} required className={inputClass}>
                <option value="" disabled>
                  Selecciona una tarjeta…
                </option>
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.name} — disponible {formatCents(card.availableCents)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">
                Cada ocurrencia consume el cupo de la tarjeta.
              </span>
              <FieldError message={state.fieldErrors?.cardId} />
            </label>
          ) : (
            <input type="hidden" name="cardId" value="" />
          )}
        </>
      ) : (
        <>
          <input type="hidden" name="paymentMethod" value="cash" />
          <input type="hidden" name="cardId" value="" />
        </>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Nota (opcional)</span>
        <input
          name="note"
          maxLength={200}
          defaultValue={recurring?.note ?? ""}
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.note} />
      </label>
    </div>
  );
}

/** Rendered inside the create Sheet: field names and action are unchanged. */
function CreateRecurringForm({
  action,
  categories,
  members,
  cards,
}: {
  action: RecurringAction;
  categories: CategoryView[];
  members: { id: string; name: string; isActive: boolean }[];
  cards: CardOption[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <RecurringFields state={state} categories={categories} members={members} cards={cards} />
      <FormError state={state} />
      <OkMessage state={state} text="Recurrencia creada." />
      <SubmitButton pending={pending}>Crear recurrente</SubmitButton>
    </form>
  );
}

/**
 * Rendered inside the edit Sheet: update + pause/resume forms keep their
 * exact field names and server actions. Delete lives on the row.
 */
function EditRecurringForm({
  recurring,
  categories,
  members,
  cards,
  updateAction,
  toggleAction,
}: {
  recurring: RecurringView;
  categories: CategoryView[];
  members: { id: string; name: string; isActive: boolean }[];
  cards: CardOption[];
  updateAction: RecurringAction;
  toggleAction: RecurringAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [toggleState, toggleFormAction, togglePending] = useActionState(toggleAction, {});

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={recurring.id} />
        <RecurringFields
          state={state}
          categories={categories}
          members={members}
          cards={cards}
          recurring={recurring}
        />
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
      </form>
      <form action={toggleFormAction} className="flex flex-col gap-2 border-t border-line pt-4">
        <input type="hidden" name="id" value={recurring.id} />
        <FormError state={toggleState} />
        <SubmitButton pending={togglePending} variant="secondary">
          {recurring.isActive ? "Pausar" : "Reactivar"}
        </SubmitButton>
      </form>
    </div>
  );
}

export default function RecurringPanel({
  recurring,
  categories,
  members,
  cards,
  isAdmin,
  createAction,
  updateAction,
  toggleAction,
  deleteAction,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});
  const editing = recurring.find((item) => item.id === editingId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      {isAdmin && (
        <CreateTrigger label="Nuevo recurrente" onClick={() => setCreating(true)} />
      )}

      <FormError state={deleteState} />
      <OkMessage state={deleteState} text="Recurrencia eliminada. Sus movimientos ya generados se conservan." />

      {recurring.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
          Todavía no hay movimientos recurrentes.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {recurring.map((item) => (
            <li
              key={item.id}
              className={`flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm ${
                item.isActive ? "" : "opacity-60"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={item.isActive ? "font-medium text-ink" : "font-medium text-muted"}>
                  {item.name}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <ScopeBadge scope={item.scope} />
                  {/* Monthly is the default shape — the day chip already says it. */}
                  {item.frequency !== "monthly" && (
                    <span className={DAY_CHIP}>{FREQUENCY_LABELS[item.frequency]}</span>
                  )}
                  {item.frequency !== "weekly" && (
                    <span className={DAY_CHIP}>Día {item.dayOfMonth}</span>
                  )}
                  {item.cardName && <span className={DAY_CHIP}>{item.cardName}</span>}
                  <ActiveBadge active={item.isActive} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={`w-fit tabular-nums text-on-accent ${
                    item.type === "income" ? AMOUNT_INCOME : AMOUNT_EXPENSE
                  }`}
                >
                  {formatCents(item.amountCents)}
                </span>
                <span className="flex items-center gap-2 text-muted">
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-full ring-1 ring-ink/10"
                    style={{ backgroundColor: item.categoryColor }}
                  />
                  {item.categoryName}
                </span>
                <span className="text-muted">· {item.memberName}</span>
                {item.lastMaterializedMonth && (
                  <span className="text-xs text-muted">
                    · último: {item.lastMaterializedMonth.slice(0, 7)}
                  </span>
                )}
              </div>
              {item.note && <p className="text-xs text-muted">{item.note}</p>}
              {isAdmin && (
                <div className="flex justify-end gap-1 border-t border-line pt-1">
                  <IconEditButton
                    label={`Editar ${item.name}`}
                    onClick={() => setEditingId(item.id)}
                  />
                  <IconDeleteButton
                    label={`Eliminar ${item.name}`}
                    confirm={`¿Eliminar "${item.name}"? Los movimientos ya generados se conservan.`}
                    id={item.id}
                    formAction={deleteFormAction}
                    pending={deletePending}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <>
          <Sheet open={creating} onClose={() => setCreating(false)} title="Nuevo recurrente">
            <CreateRecurringForm
              action={createAction}
              categories={categories}
              members={members}
              cards={cards}
            />
          </Sheet>
          <Sheet
            open={editing !== null}
            onClose={() => setEditingId(null)}
            title="Editar recurrente"
          >
            {editing && (
              <EditRecurringForm
                recurring={editing}
                categories={categories}
                members={members}
                cards={cards}
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
