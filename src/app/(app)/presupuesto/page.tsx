import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { todayIso } from "@/features/transactions/service";
import { getMonth } from "@/features/budgets/service";
import { computeProgress, monthBounds } from "@/features/budgets/progress";
import {
  copyPreviousBudgetAction,
  setBudgetsAction,
} from "@/features/budgets/actions";
import { formatCents } from "@/lib/money";
import { ProgressBar } from "@/components/progress";
import { inputClass } from "@/components/forms";
import BudgetEditor from "./budget-editor";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function singleParam(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** "2026-09" → "septiembre de 2026" for the heading (display only). */
function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, monthNumber - 1, 1)),
  );
}

export default async function PresupuestoPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;

  // Malformed or missing month falls back to the current one.
  const raw = singleParam(params, "month") ?? "";
  const month = monthBounds(raw) ? raw : todayIso().slice(0, 7);

  const view = await getMonth(getDb(), month);
  if (!view) return null;

  const totals = computeProgress(view.totals.plannedCents, view.totals.spentCents);
  const balanceCents = view.context.incomeCents - view.context.expenseCents;
  const isAdmin = user.role === "admin";

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold capitalize tracking-tight text-zinc-900 dark:text-zinc-50">
        Presupuesto de {monthLabel(month)}
      </h1>

      {/* Shareable, no-JS month picker: a plain GET form over the search params. */}
      <form
        method="get"
        action="/presupuesto"
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Mes</span>
          <input type="month" name="month" defaultValue={month} className={inputClass} />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Filtrar
        </button>
      </form>

      <div data-tour="presupuesto-resumen" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Presupuestado</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {formatCents(view.totals.plannedCents)}
          </p>
        </article>
        <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Gastado</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">
            {formatCents(view.totals.spentCents)}
          </p>
        </article>
        <article className="flex flex-col gap-2 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">% del presupuesto</h2>
          <p className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {totals.pct}%
          </p>
          <ProgressBar pct={totals.pct} status={totals.status} />
        </article>
        <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Ingresos del mes</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatCents(view.context.incomeCents)}
          </p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Saldo:{" "}
            <span
              className={`font-semibold tabular-nums ${
                balanceCents < 0 ? "text-red-600 dark:text-red-400" : "text-zinc-900 dark:text-zinc-50"
              }`}
            >
              {formatCents(balanceCents)}
            </span>
          </p>
        </article>
      </div>

      <div data-tour="presupuesto-tabla" className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-6 py-3 font-medium">Categoría</th>
              <th className="px-4 py-3 text-right font-medium">Presupuestado</th>
              <th className="px-4 py-3 text-right font-medium">Gastado</th>
              <th className="px-4 py-3 font-medium">Avance</th>
              <th className="px-6 py-3 text-right font-medium">Restante</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr
                key={row.categoryId}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
              >
                <td className="px-6 py-3">
                  <span className="flex items-center gap-2 font-medium text-zinc-900 dark:text-zinc-50">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: row.color }}
                    />
                    {row.categoryName}
                    {row.plannedCents === 0 && (
                      <span className="text-xs font-normal text-amber-600 dark:text-amber-400">
                        Sin presupuestar
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {formatCents(row.plannedCents)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {formatCents(row.spentCents)}
                </td>
                <td className="w-48 px-4 py-3">
                  <ProgressBar pct={row.pct} status={row.status} />
                </td>
                <td
                  className={`px-6 py-3 text-right tabular-nums ${
                    row.remainingCents < 0
                      ? "font-medium text-red-600 dark:text-red-400"
                      : "text-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  {formatCents(row.remainingCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div data-tour="presupuesto-editor">
          <BudgetEditor
            month={month}
            rows={view.rows.map(({ categoryId, categoryName, plannedCents }) => ({
              categoryId,
              categoryName,
              plannedCents,
            }))}
            setAction={setBudgetsAction}
            copyAction={copyPreviousBudgetAction}
          />
        </div>
      )}
    </section>
  );
}
