/**
 * Derived in-app notifications (F7) — the bell's data, computed on READ.
 *
 * ZERO new state, ZERO migrations (roadmap decision 7): every item derives
 * from the EXISTING read surfaces — budgets.getMonth, listGoals, listLoans —
 * the same reads the panels already run (including their lazy catch-ups).
 * `now` is injectable so tests pin thresholds and month-wrap math exactly.
 *
 * Items carry a STABLE id (budget-{categoryId}, card-close-{loanId}, …) so a
 * repeated derivation of the same state yields the same ids and the count is
 * stable. Order: warn first, then info, then by title.
 */
import type { Database } from "@/db";
import { getMonth } from "@/features/budgets/service";
import { listGoals } from "@/features/savings/service";
import { listLoans } from "@/features/loans/service";
import { asLocalDate, dateFormatter, dayIndexOfIso, todayIso } from "@/lib/date";
import { formatCents } from "@/lib/money";

export type NotificationSeverity = "info" | "warn";

export interface DerivedNotification {
  /** Stable across derivations of the same state (dedup/count key). */
  id: string;
  severity: NotificationSeverity;
  title: string;
  detail?: string;
  href: string;
}

/** Budget execution where a notification starts (80% of the plan). */
const BUDGET_NOTIFY_RATIO = 0.8;
/** Goal-deadline windows: announce within 30 days, warn within 7. */
const GOAL_DEADLINE_DAYS = 30;
const GOAL_DEADLINE_WARN_DAYS = 7;
/** Card-statement / bank-cuota window: at most 3 days to the anchor day. */
const DUE_DAY_WINDOW = 3;

/** Days in a 1-based month — fixed UTC arithmetic, same shape as monthBounds. */
function daysInMonth(year: number, month1based: number): number {
  return new Date(Date.UTC(year, month1based, 0)).getUTCDate();
}

/**
 * Days until the NEXT occurrence of a monthly anchor day (1..28); 0 = today.
 * Past day N this month the next occurrence is next month's N, so the wrap
 * uses the CURRENT month's length: Sep 28 with day 1 (30-day month) → 3.
 */
export function daysUntilDayOfMonth(today: string, day: number): number {
  const [year, month, dayOfMonth] = today.split("-").map(Number);
  return dayOfMonth <= day ? day - dayOfMonth : daysInMonth(year, month) - dayOfMonth + day;
}

/** "en 1 día" / "en 3 días". */
function dayWord(days: number): string {
  return days === 1 ? "día" : "días";
}

function budgetItem(
  id: string,
  title: string,
  plannedCents: number,
  spentCents: number,
): DerivedNotification {
  return {
    id,
    severity: spentCents >= plannedCents ? "warn" : "info",
    title,
    detail: `Gastaste ${formatCents(spentCents)} de ${formatCents(plannedCents)}`,
    href: "/presupuesto",
  };
}

export async function deriveNotifications(
  db: Database,
  now: Date = new Date(),
): Promise<DerivedNotification[]> {
  const today = todayIso(now);
  const [budgetMonth, goals, loans] = await Promise.all([
    getMonth(db, today.slice(0, 7)),
    listGoals(db),
    listLoans(db),
  ]);

  const items: DerivedNotification[] = [];

  // 1. Presupuesto al 80%: per planned category plus the global totals.
  if (budgetMonth) {
    for (const row of budgetMonth.rows) {
      // planned 0 = explicitly unplanned category: nothing to alert on.
      if (row.plannedCents > 0 && row.spentCents / row.plannedCents >= BUDGET_NOTIFY_RATIO) {
        items.push(
          budgetItem(
            `budget-${row.categoryId}`,
            `Presupuesto de ${row.categoryName} al ${row.pct}%`,
            row.plannedCents,
            row.spentCents,
          ),
        );
      }
    }
    const { plannedCents, spentCents, pct } = budgetMonth.totals;
    if (plannedCents > 0 && spentCents / plannedCents >= BUDGET_NOTIFY_RATIO) {
      items.push(budgetItem("budget-total", `Presupuesto global al ${pct}%`, plannedCents, spentCents));
    }
  }

  for (const loan of loans) {
    if (!loan.isActive) continue;
    // 2. Cierre de tarjeta: revolving statement day within the window.
    if (loan.amortizationMode === "revolving" && loan.statementDay !== null) {
      const days = daysUntilDayOfMonth(today, loan.statementDay);
      if (days <= DUE_DAY_WINDOW) {
        items.push({
          id: `card-close-${loan.id}`,
          severity: "info",
          title:
            days === 0
              ? `La tarjeta ${loan.name} cierra hoy`
              : `La tarjeta ${loan.name} cierra en ${days} ${dayWord(days)}`,
          href: "/prestamos",
        });
      }
    }
    // 3. Cuota próxima: bank cuota day within the window. A settled loan
    // (outstanding ≤ 0) has no next cuota to announce.
    if (loan.amortizationMode === "bank" && loan.cuotaDay !== null && loan.outstandingCents > 0) {
      const days = daysUntilDayOfMonth(today, loan.cuotaDay);
      if (days <= DUE_DAY_WINDOW) {
        items.push({
          id: `cuota-${loan.id}`,
          severity: "info",
          title: `Cuota de ${loan.name} el día ${loan.cuotaDay}`,
          href: "/prestamos",
        });
      }
    }
  }

  // 4. Meta por vencer: active savings goals with a deadline inside 30 days
  // (warn inside 7) or already overdue. Inactive goals stopped being plans.
  for (const goal of goals) {
    if (!goal.isActive || goal.kind !== "savings" || goal.deadline === null) continue;
    const days = dayIndexOfIso(goal.deadline) - dayIndexOfIso(today);
    if (days > GOAL_DEADLINE_DAYS) continue;
    const fecha = dateFormatter.format(asLocalDate(goal.deadline));
    items.push({
      id: `goal-${goal.id}`,
      severity: days <= GOAL_DEADLINE_WARN_DAYS ? "warn" : "info",
      title:
        days < 0
          ? `La meta ${goal.name} venció el ${fecha}`
          : `La meta ${goal.name} vence el ${fecha}`,
      href: "/bolsas",
    });
  }

  const severityRank = { warn: 0, info: 1 } as const;
  return items.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] || a.title.localeCompare(b.title, "es"),
  );
}
