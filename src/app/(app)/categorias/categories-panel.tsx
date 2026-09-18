"use client";

import { useActionState } from "react";
import type { CategoryView } from "@/features/categories/service";
import type { FormState } from "@/lib/form-state";
import {
  ActiveBadge,
  EditDetails,
  FieldError,
  FormError,
  OkMessage,
  SubmitButton,
  inputClass,
} from "@/components/forms";

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
        className="size-3 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/20"
        style={{ backgroundColor: category.color }}
      />
      {category.icon && <span aria-hidden>{category.icon}</span>}
      <span className={category.isActive ? "" : "text-zinc-400 dark:text-zinc-500"}>
        {category.name}
      </span>
    </span>
  );
}

function CategoryFields({ state, category }: { state: FormState; category?: CategoryView }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Nombre</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Tipo</span>
          <select name="kind" defaultValue="expense" className={inputClass}>
            <option value="expense">Gasto</option>
            <option value="income">Ingreso</option>
          </select>
          <FieldError message={state.fieldErrors?.kind} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Color</span>
        <input
          name="color"
          type="color"
          defaultValue={category?.color ?? "#64748b"}
          className="h-10 w-full rounded-lg border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-800"
        />
        <FieldError message={state.fieldErrors?.color} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Ícono (opcional)</span>
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

function CreateCategoryForm({ action }: { action: CategoryAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      data-tour="categorias-crear"
      className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Nueva categoría</h2>
      <CategoryFields state={state} />
      <FormError state={state} />
      <SubmitButton pending={pending}>Crear categoría</SubmitButton>
    </form>
  );
}

function EditCategoryForm({
  category,
  updateAction,
  toggleAction,
  deleteAction,
}: {
  category: CategoryView;
  updateAction: CategoryAction;
  toggleAction: CategoryAction;
  deleteAction: CategoryAction;
}) {
  const [state, formAction, pending] = useActionState(updateAction, {});
  const [toggleState, toggleFormAction, togglePending] = useActionState(toggleAction, {});
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteAction, {});

  return (
    <EditDetails
      summary={
        <>
          <NameIcon category={category} />
          <span className="ml-auto">
            <ActiveBadge active={category.isActive} />
          </span>
        </>
      }
    >
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={category.id} />
        <CategoryFields state={state} category={category} />
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar cambios</SubmitButton>
      </form>
      <div className="flex flex-wrap items-start gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <form action={toggleFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={category.id} />
          <FormError state={toggleState} />
          <SubmitButton pending={togglePending} variant="secondary">
            {category.isActive ? "Desactivar" : "Activar"}
          </SubmitButton>
        </form>
        <form action={deleteFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={category.id} />
          <FormError state={deleteState} />
          <OkMessage state={deleteState} text="Categoría eliminada." />
          <SubmitButton pending={deletePending} variant="danger">
            Eliminar
          </SubmitButton>
        </form>
      </div>
    </EditDetails>
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
  return (
    <div className="flex flex-col gap-8">
      {SECTIONS.map((section, sectionIndex) => {
        const items = categories.filter((c) => c.kind === section.kind);
        return (
          <div key={section.kind} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {section.title}
            </h2>
            {items.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Todavía no hay categorías en esta sección.
              </p>
            ) : (
              <ul
                data-tour={sectionIndex === 0 ? "categorias-editar" : undefined}
                className="flex flex-col gap-2"
              >
                {items.map((category) =>
                  isAdmin ? (
                    <li key={category.id}>
                      <EditCategoryForm
                        category={category}
                        updateAction={updateAction}
                        toggleAction={toggleAction}
                        deleteAction={deleteAction}
                      />
                    </li>
                  ) : (
                    <li
                      key={category.id}
                      className={`flex items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-white px-6 py-4 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${
                        category.isActive ? "" : "opacity-60"
                      }`}
                    >
                      <NameIcon category={category} />
                      <ActiveBadge active={category.isActive} />
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        );
      })}

      {isAdmin && <CreateCategoryForm action={createAction} />}
    </div>
  );
}
