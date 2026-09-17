import { and, eq, gte, lte, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { transactions } from "@/db/schema";
import { formatCents } from "@/lib/money";
import { requireUser } from "@/features/auth/session";

/** [firstDay, lastDay] of the current month as ISO dates (date column is string mode). */
function currentMonthRange(now = new Date()): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end) };
}

async function monthTotal(type: "income" | "expense"): Promise<number> {
  const { start, end } = currentMonthRange();
  const [row] = await getDb()
    .select({ total: sum(transactions.amountCents) })
    .from(transactions)
    .where(
      and(gte(transactions.date, start), lte(transactions.date, end), eq(transactions.type, type)),
    );
  return Number(row?.total ?? 0);
}

export default async function DashboardPage() {
  const user = await requireUser();
  // One query per metric — the pattern for the full dashboard in Fase 6.
  const [incomeCents, expenseCents] = await Promise.all([
    monthTotal("income"),
    monthTotal("expense"),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Hola, {user.name}
      </h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <article className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Ingresos del mes
          </h2>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-emerald-600 dark:text-emerald-400">
            {formatCents(incomeCents)}
          </p>
        </article>
        <article className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Gastos del mes
          </h2>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-red-600 dark:text-red-400">
            {formatCents(expenseCents)}
          </p>
        </article>
      </div>
    </section>
  );
}
