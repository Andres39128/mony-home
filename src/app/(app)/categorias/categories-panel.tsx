"use client";

import { useActionState, useState } from "react";
import type { CategoryView } from "@/features/categories/service";
import type { FormState } from "@/lib/form-state";
import { FALLBACK_COLOR } from "@/features/analytics/transform";
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
import { Sheet } from "@/components/sheet";

type CategoryAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  categories: CategoryView[];
  isAdmin: boolean;
  createAction: CategoryAction;
  updateAction: CategoryAction;
  toggleAction: CategoryAction;
  deleteAction: CategoryAction;
}

const SECTIONS = [
  { kind: "expense", title: "Gastos" },
  { kind: "income", title: "Ingresos" },
] as const;

function NameIcon({ category }: { category: CategoryView }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="size-3 shrink-0 rounded-full ring-1 ring-ink/10"
        style={{ backgroundColor: category.color }}
      />
      {category.icon && <span aria-hidden>{category.icon}</span>}
      <span className={category.isActive ? "" : "text-muted"}>
        {category.name}
      </span>
    </span>
  );
}

function CategoryFields({ state, category }: { state: FormState; category?: CategoryView }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Nombre</span>
        <input
          name="name"
          defaultValue={category?.name}
          required
          maxLength={64}
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.name} />
      </label>
      {category ? (
        <input type="hidden" name="kind" value={category.kind} />
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Tipo</span>
          <select name="kind" defaultValue="expense" className={inputClass}>
            <option value="expense">Gasto</option>
            <option value="income">Ingreso</option>
          </select>
          <FieldError message={state.fieldErrors?.kind} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Color</span>
        <input
          name="color"
          type="color"
          defaultValue={category?.color ?? FALLBACK_COLOR}
          className="h-10 w-full rounded-lg border border-line bg-surface p-1"
        />
        <FieldError message={state.fieldErrors?.color} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">Ícono (opcional)</span>
        <input
          name="icon"
          defaultValue={category?.icon ?? ""}
          maxLength={16}
          placeholder="🛒"
          className={inputClass}
        />
        <FieldError message={state.fieldErrors?.icon} />
      </label>
    </div>
  );
}

/** Rendered inside the create Sheet: field names and action are unchanged. */
function CreateCategoryForm({ action }: { action: CategoryAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <CategoryFields state={state} />
      <FormError state={state} />
      <OkMessage state={state} text="Categoría creada." />
      <SubmitButton pending={pending}>Crear categoría</SubmitButton>
    </form>
  );
}

/**
 * Rendered inside the single edit Sheet: update + activate/deactivate forms
 * keep their exact field names and server actions. Delete lives on the row.
 */
function EditCategoryForm({
  category,
  updateAction,
  toggleAction,
}: {
  category: CategoryView;
  updateAction: CategoryAction;
  toggleAction: CategoryAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [toggleState, toggleFormAction, togglePending] = useActionState(toggleAction, {});

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={category.id} />
        <CategoryFields state={state} category={category} />
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
      </form>
      <form action={toggleFormAction} className="flex flex-col gap-2 border-t border-line pt-4">
        <input type="hidden" name="id" value={category.id} />
        <FormError state={toggleState} />
        <SubmitButton pending={togglePending} variant="secondary">
          {category.isActive ? "Desactivar" : "Activar"}
        </SubmitButton>
      </form>
    </div>
  );
}

export default function CategoriesPanel({
  categories,
  isAdmin,
  createAction,
  updateAction,
  toggleAction,
  deleteAction,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});
  const editing = categories.find((category) => category.id === editingId) ?? null;

  return (
    <div className="flex flex-col gap-8">
      {isAdmin && (
        <CreateTrigger
          label="Nueva categoría"
          tourId="categorias-crear"
          onClick={() => setCreating(true)}
        />
      )}

      <FormError state={deleteState} />
      <OkMessage state={deleteState} text="Categoría eliminada." />

      {SECTIONS.map((section, sectionIndex) => {
        const items = categories.filter((c) => c.kind === section.kind);
        return (
          <div key={section.kind} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              {section.title}
            </h2>
            {items.length === 0 ? (
              <p className="text-sm text-muted">
                Todavía no hay categorías en esta sección.
              </p>
            ) : (
              <ul
                data-tour={sectionIndex === 0 ? "categorias-editar" : undefined}
                className="flex flex-col gap-2"
              >
                {items.map((category) => (
                  <li
                    key={category.id}
                    className={`flex flex-col gap-1 rounded-2xl border border-line bg-surface px-6 py-4 text-sm shadow-sm ${
                      category.isActive ? "" : "opacity-60"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <NameIcon category={category} />
                      <ActiveBadge active={category.isActive} />
                    </div>
                    {isAdmin && (
                      <div className="flex justify-end gap-1 border-t border-line pt-1">
                        <IconEditButton
                          label={`Editar ${category.name}`}
                          onClick={() => setEditingId(category.id)}
                        />
                        <IconDeleteButton
                          label={`Eliminar ${category.name}`}
                          confirm={`¿Eliminar la categoría "${category.name}"?`}
                          id={category.id}
                          formAction={deleteFormAction}
                          pending={deletePending}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {isAdmin && (
        <>
          <Sheet open={creating} onClose={() => setCreating(false)} title="Nueva categoría">
            <CreateCategoryForm action={createAction} />
          </Sheet>
          <Sheet
            open={editing !== null}
            onClose={() => setEditingId(null)}
            title="Editar categoría"
          >
            {editing && (
              <EditCategoryForm
                category={editing}
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
