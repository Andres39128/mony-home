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
      ? "text-emerald-600 dark:text-emerald-400"
      : totals.balanceCents < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-900 dark:text-zinc-50";

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
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
        className="grid items-end gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-7 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Mes</span>
          <input type="month" name="month" defaultValue={filters.month} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Categoría</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Integrante</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Bolsa</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Grupo</span>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Tipo</span>
          <select name="type" defaultValue={filters.type ?? ""} className={inputClass}>
            <option value="">—</option>
            <option value="income">Ingreso</option>
            <option value="expense">Gasto</option>
          </select>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Filtrar
          </button>
          <Link
            href="/movimientos"
            className="text-sm text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
          >
            Limpiar filtros
          </Link>
        </div>
      </form>

      <div data-tour="movimientos-totales" className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Ingresos</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatCents(totals.incomeCents)}
          </p>
        </article>
        <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Gastos</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">
            {formatCents(totals.expenseCents)}
          </p>
        </article>
        <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Saldo</h2>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${balanceClass}`}>
            {formatCents(totals.balanceCents)}
          </p>
        </article>
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
