"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminGuard } from "@/features/auth/session";
import {
  envelopeSchema,
  createEnvelope,
  removeEnvelope,
  toggleEnvelopeActive,
  updateEnvelope,
} from "@/features/envelopes/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar bolsas.";

function readEnvelopeForm(formData: FormData) {
  return {
    name: formData.get("name"),
    scope: formData.get("scope"),
    memberId: formData.get("memberId") ?? "",
    monthlyAmount: formData.get("monthlyAmount"),
  };
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapEnvelopeError(error: string): FormState {
  if (error === "invalid_amount") {
    return { fieldErrors: { monthlyAmount: "El monto no es válido." } };
  }
  if (error === "member_not_found") {
    return { fieldErrors: { memberId: "El integrante seleccionado no existe." } };
  }
  if (error === "has_movements") {
    return {
      error:
        "No se puede eliminar: tiene movimientos asociados. Se puede desactivar como alternativa.",
    };
  }
  if (error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
  return { error: "No se pudo guardar la bolsa." };
}

export async function createEnvelopeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const parsed = envelopeSchema.safeParse(readEnvelopeForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createEnvelope(getDb(), guard.user, parsed.data);
  if (!result.ok) return mapEnvelopeError(result.error);

  revalidatePath("/bolsas");
  return { ok: true };
}

export async function updateEnvelopeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Bolsa inválida." };

  const parsed = envelopeSchema.safeParse(readEnvelopeForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateEnvelope(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapEnvelopeError(result.error);

  revalidatePath("/bolsas");
  return { ok: true };
}

export async function toggleEnvelopeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Bolsa inválida." };

  const result = await toggleEnvelopeActive(getDb(), guard.user, id);
  if (!result.ok) return mapEnvelopeError(result.error);

  revalidatePath("/bolsas");
  return { ok: true };
}

export async function deleteEnvelopeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Bolsa inválida." };

  const result = await removeEnvelope(getDb(), guard.user, id);
  if (!result.ok) return mapEnvelopeError(result.error);

  revalidatePath("/bolsas");
  return { ok: true };
}
