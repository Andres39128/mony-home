import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import {
  listTransactionsPage,
  transactionTotals,
} from "@/features/transactions/service";
import { PAGE_SIZE, parseTransactionFilters } from "@/features/transactions/filters";
import { todayIso } from "@/lib/date";
import { movementFormOptions } from "@/features/transactions/form-options";
import { monthLabel, shiftMonth } from "@/features/transactions/month-nav";
import {
  createCategoryInlineAction,
  createMovementAction,
  deleteMovementAction,
  updateMovementAction,
} from "@/features/transactions/actions";
import { catchUpRecurringMovements } from "@/features/recurring/catch-up";
import MovementsTable from "@/features/transactions/movements-table";
import NewMovementFab from "@/features/transactions/new-movement-fab";
import FiltersSheet, { type ActiveFilter } from "@/components/filters-sheet";
import { formatCents } from "@/lib/money";
import { Card } from "@/components/card";
import { inputClass } from "@/components/forms";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

type Params = Awaited<SearchParams>;

/** URL of /movimientos with the same params, overriding/dropping some. */
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
  return qs ? `/movimientos?${qs}` : "/movimientos";
}

/** Colored money chips: pastel fill + ink/danger text, legible on both themes. */
const CHIP_INCOME = "w-fit rounded-lg bg-sage px-2 py-0.5 text-on-accent";
const CHIP_EXPENSE = "w-fit rounded-lg bg-danger-fill px-2 py-0.5 text-on-accent";
const CHIP_WEALTH = "w-fit rounded-lg bg-honey px-2 py-0.5 text-on-accent";

export default async function MovimientosPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const today = todayIso();

  const { filters, page } = parseTransactionFilters(params);

  // Lazy recurring materialization BEFORE the parallel reads so the rows it
  // creates join THIS render's list and totals (no torn first render).
  // Cold-gated: steady state pays one cheap SELECT.
  await catchUpRecurringMovements(getDb());

  const [result, totals, options] = await Promise.all([
    listTransactionsPage(getDb(), filters, page, PAGE_SIZE),
    transactionTotals(getDb(), filters),
    movementFormOptions(),
  ]);
  const { rows, total, page: safePage } = result;

  // Removable chips: one per set filter, each linking to the URL minus it.
  // Every chip also drops `page`: the result set changes, so page 3 of the
  // old set means nothing for the new one.
  const activeFilters: ActiveFilter[] = [];
  const category = options.categories.find((item) => item.id === filters.categoryId);
  if (category) {
    activeFilters.push({
      param: "categoryId",
      label: `Categoría: ${category.name}`,
      href: hrefWith(params, { categoryId: null, page: null }),
    });
  }
  const member = options.members.find((item) => item.id === filters.memberId);
  if (member) {
    activeFilters.push({
      param: "memberId",
      label: `Integrante: ${member.name}`,
      href: hrefWith(params, { memberId: null, page: null }),
    });
  }
  const group = options.groups.find((item) => item.id === filters.groupId);
  if (group) {
    activeFilters.push({
      param: "groupId",
      label: `Grupo: ${group.name}`,
      href: hrefWith(params, { groupId: null, page: null }),
    });
  }
  if (filters.type) {
    activeFilters.push({
      param: "type",
      label: `Tipo: ${filters.type === "income" ? "Ingreso" : "Gasto"}`,
      href: hrefWith(params, { type: null, page: null }),
    });
  }
  if (filters.q) {
    activeFilters.push({
      param: "q",
      label: `Búsqueda: ${filters.q}`,
      href: hrefWith(params, { q: null, page: null }),
    });
  }

  const balanceClass =
    totals.balanceCents > 0
      ? CHIP_WEALTH
      : totals.balanceCents < 0
        ? CHIP_EXPENSE
        : "text-ink";

  // Pagination: prev/next preserve every filter, first/last disable the link.
  const firstRow = (safePage - 1) * PAGE_SIZE + 1;
  const lastRow = (safePage - 1) * PAGE_SIZE + rows.length;
  const prevHref = safePage > 1 ? hrefWith(params, { page: String(safePage - 1) }) : null;
  const nextHref =
    lastRow < total ? hrefWith(params, { page: String(safePage + 1) }) : null;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Movimientos
        </h1>
        <div className="flex items-center gap-2">
          {/* Plain link: the export keeps the exact filter query string. */}
          <a
            href={hrefWith(params, { page: null })}
            className="inline-flex min-h-11 items-center self-start rounded-lg border border-line px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-base"
          >
            Exportar CSV
          </a>
          <NewMovementFab
            tourId="movimientos-nuevo"
            desktopButton
            currentUser={user}
            categories={options.categories}
            members={options.members}
            groups={options.groups}
            serverToday={today}
            createAction={createMovementAction}
            createCategoryAction={createCategoryInlineAction}
          />
        </div>
      </div>

      {/* Shareable, no-JS filters: compact bar + sheet with the GET form. */}
      <FiltersSheet
        action="/movimientos"
        tourId="movimientos-filtros"
        monthLabel={monthLabel(filters.month)}
        prevMonthHref={hrefWith(params, { month: shiftMonth(filters.month, -1), page: null })}
        nextMonthHref={hrefWith(params, { month: shiftMonth(filters.month, 1), page: null })}
        activeFilters={activeFilters}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Mes</span>
          <input type="month" name="month" defaultValue={filters.month} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Buscar en la nota</span>
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            maxLength={200}
            placeholder="Ej: supermercado"
            className={inputClass}
          />
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
      </FiltersSheet>

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
          members={options.members}
          groups={options.groups}
          serverToday={today}
          updateAction={updateMovementAction}
          deleteAction={deleteMovementAction}
          createCategoryAction={createCategoryInlineAction}
        />
      </div>

      {total > 0 && (
        <nav
          aria-label="Paginación de movimientos"
          className="flex items-center justify-between gap-3 text-sm text-muted"
        >
          <span aria-live="polite">
            {firstRow}–{lastRow} de {total}
          </span>
          <div className="flex gap-2">
            {prevHref ? (
              <a
                href={prevHref}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium transition-colors hover:bg-base"
              >
                Anterior
              </a>
            ) : (
              <span
                aria-disabled
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium opacity-40"
              >
                Anterior
              </span>
            )}
            {nextHref ? (
              <a
                href={nextHref}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium transition-colors hover:bg-base"
              >
                Siguiente
              </a>
            ) : (
              <span
                aria-disabled
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium opacity-40"
              >
                Siguiente
              </span>
            )}
          </div>
        </nav>
      )}
    </section>
  );
}
