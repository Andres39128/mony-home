import Link from "next/link";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { todayIso } from "@/features/transactions/service";
import { monthLabel, shiftMonth } from "@/features/transactions/month-nav";
import { getMonth } from "@/features/budgets/service";
import { computeProgress, monthBounds } from "@/features/budgets/progress";
import {
  copyPreviousBudgetAction,
  setBudgetsAction,
} from "@/features/budgets/actions";
import { formatCents } from "@/lib/money";
import { ProgressBar } from "@/components/progress";
import { Card } from "@/components/card";
import { ChevronLeftIcon, ChevronRightIcon, TagIcon } from "@/components/icons";
import BudgetEditor from "./budget-editor";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function singleParam(params: Record<string, string | string[] | undefined>, key: string) {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** "2026-09" → "septiembre de 2026" for the heading (display only). */
function longMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, monthNumber - 1, 1)),
  );
}

/** Remaining chip: honey pastel when on/under budget, danger when overspent. */
function remainingChipClass(remainingCents: number): string {
  return remainingCents < 0 ? "bg-danger-fill text-on-accent" : "bg-honey text-on-accent";
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold capitalize tracking-tight text-ink">
          Presupuesto de {longMonthLabel(month)}
        </h1>

        {/* Shareable month stepper: plain links over the ?month param, no JS. */}
        <nav
          aria-label="Cambiar mes"
          className="flex items-center rounded-2xl border border-line bg-surface p-2 shadow-sm"
        >
          <Link
            href={`/presupuesto?month=${shiftMonth(month, -1)}`}
            aria-label="Mes anterior"
            className="inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-base"
          >
            <ChevronLeftIcon className="size-5" />
          </Link>
          <span className="min-w-20 text-center text-sm font-medium text-ink">
            {monthLabel(month)}
          </span>
          <Link
            href={`/presupuesto?month=${shiftMonth(month, 1)}`}
            aria-label="Mes siguiente"
            className="inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-base"
          >
            <ChevronRightIcon className="size-5" />
          </Link>
        </nav>
      </div>

      <div data-tour="presupuesto-resumen" className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card className="flex flex-col gap-1 p-4">
            <h2 className="text-xs font-medium text-muted">Presupuestado</h2>
            <p className="text-xl font-semibold tabular-nums text-ink">
              {formatCents(view.totals.plannedCents)}
            </p>
          </Card>
          <Card className="flex flex-col gap-1 p-4">
            <h2 className="text-xs font-medium text-muted">Gastado</h2>
            <p className="w-fit rounded-lg bg-danger-fill px-2 py-0.5 text-xl font-semibold tabular-nums text-on-accent">
              {formatCents(view.totals.spentCents)}
            </p>
          </Card>
          <Card className="flex flex-col gap-1 p-4">
            <h2 className="text-xs font-medium text-muted">Restante</h2>
            <p
              className={`w-fit rounded-lg px-2 py-0.5 text-xl font-semibold tabular-nums ${remainingChipClass(totals.remainingCents)}`}
            >
              {formatCents(totals.remainingCents)}
            </p>
          </Card>
          <Card className="flex flex-col gap-1 p-4">
            <h2 className="text-xs font-medium text-muted">% ejecutado</h2>
            <p className="text-xl font-semibold tabular-nums text-ink">{totals.pct}%</p>
            <ProgressBar pct={totals.pct} status={totals.status} />
          </Card>
        </div>
        {/* Month income context, kept out of the KPI cards to stay compact. */}
        <p className="text-sm text-muted">
          Ingresos del mes:{" "}
          <span className="font-medium tabular-nums text-ink">
            {formatCents(view.context.incomeCents)}
          </span>
          {" · "}Saldo:{" "}
          <span
            className={`font-semibold tabular-nums ${
              balanceCents < 0
                ? "rounded-lg bg-danger-fill px-2 py-0.5 text-on-accent"
                : "text-ink"
            }`}
          >
            {formatCents(balanceCents)}
          </span>
        </p>
      </div>

      <div data-tour="presupuesto-tabla">
        {view.rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
            <TagIcon className="size-8 text-muted" />
            <p className="text-sm font-medium text-ink">
              Todavía no hay categorías para presupuestar
            </p>
            <p className="max-w-xs text-sm text-muted">
              Creá categorías de gasto activas en Categorías y volvé acá para definir los montos
              del mes.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Mobile: card rows inside one card surface, no horizontal scroll. */}
            <Card className="md:hidden">
              <ul className="divide-y divide-line">
                {view.rows.map((row) => (
                  <li key={row.categoryId} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                        <span
                          aria-hidden
                          className="inline-block size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: row.color }}
                        />
                        <span className="truncate">{row.categoryName}</span>
                      </p>
                      <span
                        className={`shrink-0 rounded-lg px-2 py-0.5 text-sm font-medium tabular-nums ${remainingChipClass(row.remainingCents)}`}
                      >
                        {formatCents(row.remainingCents)}
                      </span>
                    </div>
                    <p className="text-xs tabular-nums text-muted">
                      {formatCents(row.spentCents)} de {formatCents(row.plannedCents)}
                    </p>
                    <ProgressBar pct={row.pct} status={row.status} />
                  </li>
                ))}
              </ul>
            </Card>

            {/* md+: the full table stays, with comfortable padding. */}
            <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-muted">
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
                    <tr key={row.categoryId} className="border-b border-line last:border-0">
                      <td className="px-6 py-3">
                        <span className="flex items-center gap-2 font-medium text-ink">
                          <span
                            className="inline-block h-3 w-3 rounded-full"
                            style={{ backgroundColor: row.color }}
                          />
                          {row.categoryName}
                          {row.plannedCents === 0 && (
                            <span className="rounded bg-honey px-1 text-xs font-normal text-on-accent">
                              Sin presupuestar
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {formatCents(row.plannedCents)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {formatCents(row.spentCents)}
                      </td>
                      <td className="w-48 px-4 py-3">
                        <ProgressBar pct={row.pct} status={row.status} />
                      </td>
                      <td
                        className={`px-6 py-3 text-right tabular-nums ${
                          row.remainingCents < 0
                            ? "font-medium text-danger-text"
                            : "text-muted"
                        }`}
                      >
                        {formatCents(row.remainingCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {isAdmin && view.rows.length > 0 && (
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
