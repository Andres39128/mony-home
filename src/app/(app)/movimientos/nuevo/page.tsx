import Link from "next/link";
import { requireUser } from "@/features/auth/session";
import { todayIso } from "@/lib/date";
import { movementFormOptions } from "@/features/transactions/form-options";
import {
  createCategoryInlineAction,
  createMovementAndRedirectAction,
} from "@/features/transactions/actions";
import MovementForm from "@/features/transactions/movement-form";

/**
 * No-JS fallback for quick entry: the same MovementForm, rendered full-page.
 * The sheet on /movimientos is the primary path; this route keeps entry
 * working (progressive enhancement) without client JavaScript, redirecting
 * back to the list after a successful save.
 */
export default async function NuevoMovimientoPage() {
  const user = await requireUser();
  const options = await movementFormOptions();

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Nuevo movimiento
      </h1>
      <div className="max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <MovementForm
          mode="create"
          categories={options.categories}
          members={options.members}
          groups={options.groups}
          currentUser={user}
          serverToday={todayIso()}
          createAction={createMovementAndRedirectAction}
          updateAction={createMovementAndRedirectAction}
          createCategoryAction={createCategoryInlineAction}
        />
      </div>
      <Link
        href="/movimientos"
        className="text-sm text-muted underline-offset-2 hover:underline"
      >
        ← Volver a movimientos
      </Link>
    </section>
  );
}
