import { requireUser } from "@/features/auth/session";
import { getDb } from "@/db";
import { listRecurring } from "@/features/recurring/service";
import { movementFormOptions } from "@/features/transactions/form-options";
import {
  createRecurringAction,
  deleteRecurringAction,
  toggleRecurringAction,
  updateRecurringAction,
} from "@/features/recurring/actions";
import RecurringPanel from "./recurring-panel";

export default async function RecurrentesPage() {
  const user = await requireUser();
  const [recurring, options] = await Promise.all([
    listRecurring(getDb()),
    movementFormOptions(getDb()),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Recurrentes</h1>
        <p className="text-sm text-muted">
          Movimientos que se registran solos cada mes: alquileres, suscripciones, sueldo.
        </p>
      </div>
      <RecurringPanel
        recurring={recurring}
        categories={options.categories}
        members={options.members}
        isAdmin={user.role === "admin"}
        createAction={createRecurringAction}
        updateAction={updateRecurringAction}
        toggleAction={toggleRecurringAction}
        deleteAction={deleteRecurringAction}
      />
    </section>
  );
}
