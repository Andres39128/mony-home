import Link from "next/link";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import {
  todayIso,
  transactionTotals,
  type TransactionFilters,
} from "@/features/transactions/service";
import { movementFormOptions } from "@/features/transactions/form-options";
import { monthLabel, shiftMonth } from "@/features/transactions/month-nav";
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
import { getPatrimony } from "@/features/savings/service";
import NewMovementFab, {
  QUICK_TILE_CLASS,
} from "@/features/transactions/new-movement-fab";
import {
  createCategoryInlineAction,
  createMovementAction,
} from "@/features/transactions/actions";
import { formatCents } from "@/lib/money";
import FiltersSheet, { type ActiveFilter } from "@/components/filters-sheet";
import { Card } from "@/components/card";
import { ProgressBar } from "@/components/progress";
import { inputClass } from "@/components/forms";
import {
  ChartIcon,
  ChevronDownIcon,
  PouchIcon,
  SparklesIcon,
} from "@/components/icons";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

type Params = Awaited<SearchParams>;

function singleParam(params: Params, key: string) {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** URL of "/" with the same params, overriding/dropping some. */
function hrefWith(params: Params, overrides: Record<string, string | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key in overrides) continue;
    if (typeof value === "string" && value) query.set(key, value);
    else if (Array.isArray(value)) for (const item of value) if (item) query.append(key, item);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `/?${qs}` : "/";
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

/** Colored money chip: pastel fill + constant on-accent text, legible on both themes. */
const CHIP_INCOME = "w-fit rounded-lg bg-sage px-2 py-0.5 text-on-accent";
const CHIP_EXPENSE = "w-fit rounded-lg bg-danger-fill px-2 py-0.5 text-on-accent";

/** Hero emphasis shares the chip language at display size (no size classes here). */
function balanceHeroClass(balanceCents: number): string {
  return balanceCents > 0
    ? "bg-honey text-on-accent"
    : balanceCents < 0
      ? "bg-danger-fill text-on-accent"
      : "text-ink";
}

function KpiCard({
  title,
  value,
  valueClass = "text-ink",
  className,
  children,
}: {
  title: string;
  value: string;
  valueClass?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className={`p-5 ${className ?? ""}`}>
      <h2 className="text-sm font-medium text-muted">{title}</h2>
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
    <Card data-tour={tourId} className={`p-5 ${wide ? "lg:col-span-2" : ""}`}>
      <h2 className="mb-3 text-sm font-medium text-muted">{title}</h2>
      {emptyMessage ? (
        <p className="flex h-[240px] items-center justify-center text-sm text-muted">
          {emptyMessage}
        </p>
      ) : (
        children
      )}
    </Card>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Route guard: /login without a valid session.
  const user = await requireUser();
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

  const [options, totals, slices, monthlyRows, budgetMonth, envelopeRows, cumulativeRows, patrimony] =
    await Promise.all([
      movementFormOptions(),
      transactionTotals(getDb(), filters),
      expensesByCategory(getDb(), filters),
      monthlyTotals(getDb(), month, DEFAULT_MONTHS_BACK, filters),
      getMonth(getDb(), month),
      monthlyProgress(getDb(), month),
      cumulativeBudgetVsActual(getDb(), Number(month.slice(0, 4)), filters),
      getPatrimony(getDb()),
    ]);

  const donutData = buildDonutData(slices);
  const barsData = buildBarsData(monthlyRows);
  const linesData = buildLinesData(cumulativeRows);
  const budgetTotals = budgetMonth?.totals ?? { plannedCents: 0, spentCents: 0, pct: 0 };
  const budgetProgress = computeProgress(budgetTotals.plannedCents, budgetTotals.spentCents);

  // Removable chips: one per set filter, each linking to the URL minus it.
  const activeFilters: ActiveFilter[] = [];
  if (filters.scope) {
    activeFilters.push({
      param: "scope",
      label: `Ámbito: ${filters.scope === "individual" ? "Individual" : "Común"}`,
      href: hrefWith(params, { scope: null }),
    });
  }
  const member = options.members.find((item) => item.id === filters.memberId);
  if (member) {
    activeFilters.push({
      param: "memberId",
      label: `Integrante: ${member.name}`,
      href: hrefWith(params, { memberId: null }),
    });
  }
  const category = options.categories.find((item) => item.id === filters.categoryId);
  if (category) {
    activeFilters.push({
      param: "categoryId",
      label: `Categoría: ${category.name}`,
      href: hrefWith(params, { categoryId: null }),
    });
  }
  const envelope = options.envelopes.find((item) => item.id === filters.envelopeId);
  if (envelope) {
    activeFilters.push({
      param: "envelopeId",
      label: `Bolsa: ${envelope.name}`,
      href: hrefWith(params, { envelopeId: null }),
    });
  }
  const group = options.groups.find((item) => item.id === filters.groupId);
  if (group) {
    activeFilters.push({
      param: "groupId",
      label: `Grupo: ${group.name}`,
      href: hrefWith(params, { groupId: null }),
    });
  }

  // Donut drill: the slice's category replaces any current one; all other
  // active filters ride along (the slice was computed under them).
  const donutQuery = drillQuery(baseParams, ["categoryId"], { month });
  // Bars drill: same filters, the clicked month replaces the current one.
  const barsQuery = drillQuery(baseParams, ["month"]);
  // Envelope progress ignores the other filters → drill carries month+bolsa only.
  const envelopeHref = (envelopeId: string) =>
    `/movimientos?${drillQuery(baseParams, ["envelopeId"], { month, envelopeId })}`;

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Dashboard
      </h1>

      {/* Shareable, no-JS filters: compact bar (month stepper + sheet) over the
          same GET params the old filter wall used. */}
      <FiltersSheet
        action="/"
        tourId="dashboard-filtros"
        monthLabel={monthLabel(month)}
        prevMonthHref={hrefWith(params, { month: shiftMonth(month, -1) })}
        nextMonthHref={hrefWith(params, { month: shiftMonth(month, 1) })}
        activeFilters={activeFilters}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Mes</span>
          <input type="month" name="month" defaultValue={month} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Ámbito</span>
          <select name="scope" defaultValue={filters.scope ?? ""} className={inputClass}>
            <option value="">Todos</option>
            <option value="individual">Individual</option>
            <option value="common">Común</option>
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
          <span className="font-medium text-muted">Bolsa</span>
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
      </FiltersSheet>

      {/* KPI strip: the period's net balance leads as the hero figure; below
          it the income/expense/budget row and the patrimony link. */}
      <div data-tour="dashboard-kpis" className="flex flex-col gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-medium text-muted">Saldo del período</h2>
          <p
            className={`mt-2 inline-block rounded-xl px-3 py-1 text-3xl font-semibold tabular-nums sm:text-4xl ${balanceHeroClass(totals.balanceCents)}`}
          >
            {formatCents(totals.balanceCents)}
          </p>
        </Card>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <KpiCard
            title="Ingresos"
            value={formatCents(totals.incomeCents)}
            valueClass={CHIP_INCOME}
          />
          <KpiCard
            title="Gastos"
            value={formatCents(totals.expenseCents)}
            valueClass={CHIP_EXPENSE}
          />
          <KpiCard
            className="col-span-2 lg:col-span-1"
            title="Presupuesto ejecutado"
            value={`${budgetTotals.pct}%`}
            valueClass={budgetProgress.status === "over" ? CHIP_EXPENSE : "text-ink"}
          >
            <div className="mt-2">
              <ProgressBar pct={budgetProgress.pct} status={budgetProgress.status} />
            </div>
            <p className="mt-1 text-xs text-muted">
              de {formatCents(budgetTotals.plannedCents)} planificados
            </p>
          </KpiCard>
        </div>

        {/* Visually distinct strip: NET worth — money saved minus money owed —
            fed by the savings ledger and the loans ledger, never the movements
            stats. Debts surface in red when there is anything outstanding. */}
        <Link
          href="/ahorro"
          data-tour="dashboard-patrimonio"
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-2xl border border-honey bg-honey/40 p-5 shadow-sm transition-colors hover:bg-honey/60"
        >
          <h2 className="text-sm font-medium text-ink">
            Patrimonio neto
          </h2>
          <p className="text-2xl font-semibold tabular-nums text-ink">
            {formatCents(patrimony.totalCents)}
          </p>
          <p className="text-sm text-ink">
            Ahorro {formatCents(patrimony.savingsCents)} · Inversión{" "}
            {formatCents(patrimony.investmentsCents)}
            {patrimony.debtCents > 0 && (
              <>
                {" · "}
                <span className="font-medium text-danger-text">
                  Deudas: {formatCents(patrimony.debtCents)}
                </span>
              </>
            )}
          </p>
        </Link>
      </div>

      {/* Quick access: capture first, then the three related screens. The
          tile reuses the new-movement sheet (one instance, one form). */}
      <nav aria-label="Accesos rápidos" className="grid grid-cols-4 gap-2 sm:max-w-md">
        <NewMovementFab
          variant="tile"
          currentUser={user}
          categories={options.categories}
          envelopes={options.envelopes}
          members={options.members}
          groups={options.groups}
          serverToday={today}
          createAction={createMovementAction}
          createCategoryAction={createCategoryInlineAction}
        />
        <Link href="/bolsas" className={QUICK_TILE_CLASS}>
          <PouchIcon className="size-5" />
          Bolsas
        </Link>
        <Link href="/presupuesto" className={QUICK_TILE_CLASS}>
          <ChartIcon className="size-5" />
          Presupuesto
        </Link>
        <Link href="/asistente" className={QUICK_TILE_CLASS}>
          <SparklesIcon className="size-5" />
          Asistente
        </Link>
      </nav>

      {/* Envelope progress for the period, one row per bolsa. */}
      <ChartCard
        title={`Bolsas de ${month}`}
        tourId="dashboard-bolsas"
        emptyMessage={envelopeRows.length === 0 ? "Sin bolsas activas" : null}
      >
        <ul className="flex flex-col gap-4">
          {envelopeRows.map((row) => (
            <li key={row.id}>
              <Link
                href={envelopeHref(row.id)}
                className="group block rounded-lg transition-colors hover:bg-base"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="font-medium text-muted group-hover:underline">
                    {row.name}
                    {row.scope === "individual" && row.memberName ? ` · ${row.memberName}` : ""}
                  </span>
                  <span className="tabular-nums text-muted">
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

      {/* Charts collapsed by default (mobile-first): a native <details>
          keeps it no-JS; the tour opens ancestors before highlighting. */}
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line pb-3 [&::-webkit-details-marker]:hidden">
          <h2 className="text-sm font-medium text-muted">Ver gráficos del período</h2>
          <span className="flex items-center gap-2 text-xs text-muted">
            3 gráficos · evolución, presupuesto y categorías
            <ChevronDownIcon className="size-4 shrink-0 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
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
        </div>
      </details>
    </section>
  );
}
