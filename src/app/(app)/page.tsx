import Link from "next/link";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import {
  todayIso,
  transactionTotals,
  type TransactionFilters,
} from "@/features/transactions/service";
import { movementFormOptions } from "@/features/transactions/form-options";
import {
  DEFAULT_MONTHS_BACK,
  cumulativeBudgetVsActual,
  expensesByCategory,
  monthlyTotals,
} from "@/features/analytics/service";
import {
  buildBarsData,
  buildDonutData,
  buildLinesData,
  hasCumulativeData,
  hasFlowData,
} from "@/features/analytics/transform";
import CategoryDonut from "@/features/analytics/charts/category-donut";
import MonthlyBars from "@/features/analytics/charts/monthly-bars";
import BudgetLines from "@/features/analytics/charts/budget-lines";
import { monthBounds, computeProgress } from "@/features/budgets/progress";
import { getMonth } from "@/features/budgets/service";
import { monthlyProgress } from "@/features/envelopes/service";
import { formatCents } from "@/lib/money";
import { ProgressBar } from "@/components/progress";
import { inputClass } from "@/components/forms";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function singleParam(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Active filters as a query string, dropping/overriding keys per chart. */
function drillQuery(
  base: URLSearchParams,
  dropKeys: string[],
  overrides: Record<string, string> = {},
): string {
  const next = new URLSearchParams(base);
  for (const key of dropKeys) next.delete(key);
  for (const [key, value] of Object.entries(overrides)) next.set(key, value);
  return next.toString();
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {children}
    </article>
  );
}

function KpiCard({
  title,
  value,
  valueClass = "text-zinc-900 dark:text-zinc-50",
  children,
}: {
  title: string;
  value: string;
  valueClass?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{title}</h2>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {children}
    </Card>
  );
}

function ChartCard({
  title,
  wide = false,
  emptyMessage,
  tourId,
  children,
}: {
  title: string;
  wide?: boolean;
  /** When set, renders the empty state instead of the chart. */
  emptyMessage: string | null;
  /** Optional data-tour anchor for the guided tour. */
  tourId?: string;
  children: React.ReactNode;
}) {
  return (
    <article
      data-tour={tourId}
      className={`rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${
        wide ? "lg:col-span-2" : ""
      }`}
    >
      <h2 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">{title}</h2>
      {emptyMessage ? (
        <p className="flex h-[240px] items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
          {emptyMessage}
        </p>
      ) : (
        children
      )}
    </article>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Route guard: /login without a valid session.
  await requireUser();
  const params = await searchParams;
  const today = todayIso();

  const rawMonth = singleParam(params, "month") ?? today.slice(0, 7);
  // A malformed or out-of-range month falls back to the current one.
  const month = monthBounds(rawMonth) ? rawMonth : today.slice(0, 7);
  const scopeParam = singleParam(params, "scope");

  const filters: TransactionFilters = {
    month,
    memberId: singleParam(params, "memberId"),
    scope: scopeParam === "individual" || scopeParam === "common" ? scopeParam : undefined,
    categoryId: singleParam(params, "categoryId"),
    envelopeId: singleParam(params, "envelopeId"),
    groupId: singleParam(params, "groupId"),
  };

  // Base for every drill-down: only the filters actually set.
  const baseParams = new URLSearchParams();
  if (filters.memberId) baseParams.set("memberId", filters.memberId);
  if (filters.scope) baseParams.set("scope", filters.scope);
  if (filters.categoryId) baseParams.set("categoryId", filters.categoryId);
  if (filters.envelopeId) baseParams.set("envelopeId", filters.envelopeId);
  if (filters.groupId) baseParams.set("groupId", filters.groupId);

  const [options, totals, slices, monthlyRows, budgetMonth, envelopeRows, cumulativeRows] =
    await Promise.all([
      movementFormOptions(),
      transactionTotals(getDb(), filters),
      expensesByCategory(getDb(), filters),
      monthlyTotals(getDb(), month, DEFAULT_MONTHS_BACK, filters),
      getMonth(getDb(), month),
      monthlyProgress(getDb(), month),
      cumulativeBudgetVsActual(getDb(), Number(month.slice(0, 4)), filters),
    ]);

  const donutData = buildDonutData(slices);
  const barsData = buildBarsData(monthlyRows);
  const linesData = buildLinesData(cumulativeRows);
  const budgetTotals = budgetMonth?.totals ?? { plannedCents: 0, spentCents: 0, pct: 0 };
  const budgetProgress = computeProgress(budgetTotals.plannedCents, budgetTotals.spentCents);

  // Donut drill: the slice's category replaces any current one; all other
  // active filters ride along (the slice was computed under them).
  const donutQuery = drillQuery(baseParams, ["categoryId"], { month });
  // Bars drill: same filters, the clicked month replaces the current one.
  const barsQuery = drillQuery(baseParams, ["month"]);
  // Envelope progress ignores the other filters → drill carries month+bolsa only.
  const envelopeHref = (envelopeId: string) =>
    `/movimientos?${drillQuery(baseParams, ["envelopeId"], { month, envelopeId })}`;

  const balanceClass =
    totals.balanceCents > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : totals.balanceCents < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-900 dark:text-zinc-50";

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Dashboard
      </h1>

      {/* Shareable, no-JS filters: a plain GET form over the search params. */}
      <form
        method="get"
        action="/"
        data-tour="dashboard-filtros"
        className="grid items-end gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-7 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Mes</span>
          <input type="month" name="month" defaultValue={month} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Ámbito</span>
          <select name="scope" defaultValue={filters.scope ?? ""} className={inputClass}>
            <option value="">Todos</option>
            <option value="individual">Individual</option>
            <option value="common">Común</option>
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
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Bolsa</span>
          <select name="envelopeId" defaultValue={filters.envelopeId ?? ""} className={inputClass}>
            <option value="">—</option>
            {options.envelopes.map((envelope) => (
              <option key={envelope.id} value={envelope.id}>
                {envelope.name}
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
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Filtrar
          </button>
          <Link
            href="/"
            className="text-sm text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
          >
            Limpiar
          </Link>
        </div>
      </form>

      <div data-tour="dashboard-kpis" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Ingresos"
          value={formatCents(totals.incomeCents)}
          valueClass="text-emerald-600 dark:text-emerald-400"
        />
        <KpiCard
          title="Gastos"
          value={formatCents(totals.expenseCents)}
          valueClass="text-red-600 dark:text-red-400"
        />
        <KpiCard title="Saldo" value={formatCents(totals.balanceCents)} valueClass={balanceClass} />
        <KpiCard
          title="Presupuesto ejecutado"
          value={`${budgetTotals.pct}%`}
          valueClass={budgetProgress.status === "over" ? "text-red-600 dark:text-red-400" : "text-zinc-900 dark:text-zinc-50"}
        >
          <div className="mt-2">
            <ProgressBar pct={budgetProgress.pct} status={budgetProgress.status} />
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            de {formatCents(budgetTotals.plannedCents)} planificados
          </p>
        </KpiCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Gastos por categoría"
          tourId="dashboard-donut"
          emptyMessage={donutData.length === 0 ? "Sin gastos en el período" : null}
        >
          <CategoryDonut
            slices={donutData}
            totalCents={donutData.reduce((total, slice) => total + slice.cents, 0)}
            drillQuery={donutQuery}
          />
        </ChartCard>

        <ChartCard
          title="Ingresos vs Gastos · últimos 12 meses"
          tourId="dashboard-barras"
          emptyMessage={hasFlowData(barsData) ? null : "Sin datos en el período"}
        >
          <MonthlyBars data={barsData} drillQuery={barsQuery} />
        </ChartCard>

        <ChartCard
          wide
          title={`Presupuesto acumulado vs gasto acumulado · ${month.slice(0, 4)}`}
          tourId="dashboard-acumulado"
          emptyMessage={hasCumulativeData(linesData) ? null : "Sin datos en el período"}
        >
          <BudgetLines data={linesData} />
        </ChartCard>

        <ChartCard
          wide
          title={`Bolsas de ${month}`}
          tourId="dashboard-bolsas"
          emptyMessage={envelopeRows.length === 0 ? "Sin bolsas activas" : null}
        >
          <ul className="flex flex-col gap-4">
            {envelopeRows.map((row) => (
              <li key={row.id}>
                <Link
                  href={envelopeHref(row.id)}
                  className="group block rounded-lg transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    <span className="font-medium text-zinc-700 group-hover:underline dark:text-zinc-300">
                      {row.name}
                      {row.scope === "individual" && row.memberName ? ` · ${row.memberName}` : ""}
                    </span>
                    <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
                      {formatCents(row.spentCents)} / {formatCents(row.plannedCents)}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <ProgressBar pct={row.pct} status={row.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </ChartCard>
      </div>
    </section>
  );
}
