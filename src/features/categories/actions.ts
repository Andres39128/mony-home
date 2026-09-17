"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminGuard, requireUser } from "@/features/auth/session";
import {
  categorySchema,
  createCategory,
  removeCategory,
  toggleCategoryActive,
  updateCategory,
} from "@/features/categories/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden modificar categorías.";

function readCategoryForm(formData: FormData) {
  return {
    name: formData.get("name"),
    kind: formData.get("kind"),
    color: formData.get("color"),
    icon: formData.get("icon") ?? "",
  };
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapCategoryError(error: string): FormState {
  if (error === "name_taken") {
    return { fieldErrors: { name: "Ya existe una categoría con ese nombre." } };
  }
  if (error === "has_movements") {
    return {
      error:
        "No se puede eliminar: tiene movimientos o presupuestos asociados. Se puede desactivar como alternativa.",
    };
  }
  if (error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
  return { error: "No se pudo guardar la categoría." };
}

/** Open to any authenticated member — expense entry creates categories on the fly. */
export async function createCategoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser();

  const parsed = categorySchema.safeParse(readCategoryForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createCategory(getDb(), parsed.data);
  if (!result.ok) return mapCategoryError(result.error);

  revalidatePath("/categorias");
  return { ok: true };
}

export async function updateCategoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Categoría inválida." };

  const parsed = categorySchema.safeParse(readCategoryForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateCategory(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapCategoryError(result.error);

  revalidatePath("/categorias");
  return { ok: true };
}

export async function toggleCategoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Categoría inválida." };

  const result = await toggleCategoryActive(getDb(), guard.user, id);
  if (!result.ok) return mapCategoryError(result.error);

  revalidatePath("/categorias");
  return { ok: true };
}

export async function deleteCategoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Categoría inválida." };

  const result = await removeCategory(getDb(), guard.user, id);
  if (!result.ok) return mapCategoryError(result.error);

  revalidatePath("/categorias");
  return { ok: true };
}
