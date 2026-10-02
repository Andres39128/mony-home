import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { listCategories } from "@/features/categories/service";
import { listMembers } from "@/features/members/service";
import { importMovementsAction } from "@/features/transactions/actions";
import { IMPORT_MAX_BYTES } from "@/features/transactions/import";
import ImportWizard from "./import-wizard";

/**
 * Admin-only CSV import (F5). UI hiding is never trusted: the page bounces
 * non-admins server-side and the action re-checks the role on every call.
 */
export default async function ImportarMovimientosPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/movimientos");

  const [categories, members] = await Promise.all([
    listCategories(getDb()),
    listMembers(getDb()),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Importar movimientos
        </h1>
        <p className="text-sm text-muted">
          Traé movimientos desde un CSV en tres pasos: pegar o subir, mapear
          columnas y previsualizar antes de importar.
        </p>
      </header>
      <ImportWizard
        action={importMovementsAction}
        categories={categories.map((category) => ({
          id: category.id,
          name: category.name,
          kind: category.kind,
          isActive: category.isActive,
        }))}
        members={members.map((member) => ({
          id: member.id,
          name: member.name,
          isActive: member.isActive,
        }))}
        currentMemberId={user.id}
        maxBytes={IMPORT_MAX_BYTES}
      />
    </section>
  );
}
