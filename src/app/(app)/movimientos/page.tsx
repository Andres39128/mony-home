import Link from "next/link";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { todayIso, listTransactions, transactionTotals, type TransactionFilters } from "@/features/transactions/service";
import { movementFormOptions } from "@/features/transactions/form-options";
import {
  createCategoryInlineAction,
  createMovementAction,
  deleteMovementAction,
  updateMovementAction,
} from "@/features/transactions/actions";
import MovementsTable from "@/features/transactions/movements-table";
import NewMovementDialog from "@/features/transactions/new-movement-dialog";
import { formatCents } from "@/lib/money";
import { Card } from "@/components/card";
import { inputClass } from "@/components/forms";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function singleParam(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function envelopeFilterLabel(envelope: { name: string; scope: string; memberName: string | null }) {
  return envelope.scope === "common"
    ? `Común · ${envelope.name}`
    : `Individual · ${envelope.name} (${envelope.memberName ?? "?"})`;
}

/** Colored money chips: pastel fill + ink/danger text, legible on both themes. */
const CHIP_INCOME = "w-fit rounded-lg bg-sage px-2 py-0.5 text-ink";
const CHIP_EXPENSE = "w-fit rounded-lg bg-danger-fill px-2 py-0.5 text-danger-text";
const CHIP_WEALTH = "w-fit rounded-lg bg-honey px-2 py-0.5 text-ink";

export default async function MovimientosPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const today = todayIso();

  const typeParam = singleParam(params, "type");
  const filters: TransactionFilters = {
    month: singleParam(params, "month") ?? today.slice(0, 7),
    categoryId: singleParam(params, "categoryId"),
    memberId: singleParam(params, "memberId"),
    envelopeId: singleParam(params, "envelopeId"),
    groupId: singleParam(params, "groupId"),
    type: typeParam === "income" || typeParam === "expense" ? typeParam : undefined,
  };

  const [rows, totals, options] = await Promise.all([
    listTransactions(getDb(), filters),
    transactionTotals(getDb(), filters),
    movementFormOptions(),
  ]);

  const balanceClass =
    totals.balanceCents > 0
      ? CHIP_WEALTH
      : totals.balanceCents < 0
        ? CHIP_EXPENSE
        : "text-ink";

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Movimientos
        </h1>
        <NewMovementDialog
          tourId="movimientos-nuevo"
          currentUser={user}
          categories={options.categories}
          envelopes={options.envelopes}
          members={options.members}
          groups={options.groups}
          serverToday={today}
          createAction={createMovementAction}
          createCategoryAction={createCategoryInlineAction}
        />
      </div>

      {/* Shareable, no-JS filters: a plain GET form over the search params. */}
      <form
        method="get"
        action="/movimientos"
        data-tour="movimientos-filtros"
        className="grid items-end gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-7"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Mes</span>
          <input type="month" name="month" defaultValue={filters.month} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Categoría</span>
          <select name="categoryId" defaultValue={filters.categoryId ?? ""} className={inputClass}>
            <option value="">—</option>
            {options.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.isActive ? "" : " (inactiva)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Integrante</span>
          <select name="memberId" defaultValue={filters.memberId ?? ""} className={inputClass}>
            <option value="">—</option>
            {options.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Bolsa</span>
          <select name="envelopeId" defaultValue={filters.envelopeId ?? ""} className={inputClass}>
            <option value="">—</option>
            {options.envelopes.map((envelope) => (
              <option key={envelope.id} value={envelope.id}>
                {envelopeFilterLabel(envelope)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Grupo</span>
          <select name="groupId" defaultValue={filters.groupId ?? ""} className={inputClass}>
            <option value="">—</option>
            {options.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
                {group.status === "active" ? "" : " (cerrado)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Tipo</span>
          <select name="type" defaultValue={filters.type ?? ""} className={inputClass}>
            <option value="">—</option>
            <option value="income">Ingreso</option>
            <option value="expense">Gasto</option>
          </select>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 py-2 text-sm font-medium text-base transition-colors hover:bg-ink/90"
          >
            Filtrar
          </button>
          <Link
            href="/movimientos"
            className="inline-flex min-h-11 items-center text-sm text-muted underline-offset-2 hover:underline"
          >
            Limpiar filtros
          </Link>
        </div>
      </form>

      <div data-tour="movimientos-totales" className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <h2 className="text-sm font-medium text-muted">Ingresos</h2>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${CHIP_INCOME}`}>
            {formatCents(totals.incomeCents)}
          </p>
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-medium text-muted">Gastos</h2>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${CHIP_EXPENSE}`}>
            {formatCents(totals.expenseCents)}
          </p>
        </Card>
        <Card className="p-5">
          <h2 className="text-sm font-medium text-muted">Saldo</h2>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${balanceClass}`}>
            {formatCents(totals.balanceCents)}
          </p>
        </Card>
      </div>

      <div data-tour="movimientos-tabla">
        <MovementsTable
          rows={rows}
          currentUser={user}
          categories={options.categories}
          envelopes={options.envelopes}
          members={options.members}
          groups={options.groups}
          serverToday={today}
          updateAction={updateMovementAction}
          deleteAction={deleteMovementAction}
          createCategoryAction={createCategoryInlineAction}
        />
      </div>
    </section>
  );
}
