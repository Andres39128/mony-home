/**
 * Pure chart-data transforms for the dashboard — no DB, no React, no
 * Recharts. Server queries come in, props-ready plain objects go out; they
 * are unit-tested separately from rendering so chart math never needs a
 * browser. Labels use es-AR short months ('ene 26') to match the app's UI
 * language.
 */
import { percentage } from "@/lib/money";
import type {
  CategoryExpenseSlice,
  CumulativeBudgetPoint,
  MonthlyTotal,
} from "@/features/analytics/service";

/** Used when a category row carries an empty/invalid color. */
export const FALLBACK_COLOR = "#94a3b8";

/**
 * Series colors for the two-series charts; hex constants (Recharts needs
 * real colors, not Tailwind class names) matching the KPI palette.
 */
export const SERIES_COLORS = {
  income: "#10b981",
  expense: "#ef4444",
  planned: "#6366f1",
  actual: "#f59e0b",
} as const;

const MONTH_RE = /^\d{4}-\d{2}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** '2026-03' → 'mar 26' (es-AR short month + 2-digit year, UTC-pinned). */
export function shortMonthLabel(month: string): string {
  if (!MONTH_RE.test(month)) return month;
  const [year, monthNumber] = month.split("-").map(Number);
  // es-AR renders 'mar.' with a trailing dot; charts use the bare form.
  return new Intl.DateTimeFormat("es-AR", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)))
    .replace(".", "");
}

export interface DonutSlice {
  categoryId: string;
  name: string;
  color: string;
  cents: number;
  pct: number;
}

/**
 * Donut-ready slices: drops non-positive/invalid entries, falls back to a
 * constant name and color for degenerate rows, and re-rounds pct (or
 * recomputes it when the service value is not finite).
 */
export function buildDonutData(slices: CategoryExpenseSlice[]): DonutSlice[] {
  const valid = slices.filter(
    (slice) => Number.isFinite(slice.cents) && slice.cents > 0,
  );
  const totalCents = valid.reduce((total, slice) => total + slice.cents, 0);
  return valid.map((slice) => ({
    categoryId: slice.categoryId,
    name: slice.name.trim().length > 0 ? slice.name : "Sin categoría",
    color: HEX_COLOR_RE.test(slice.color) ? slice.color : FALLBACK_COLOR,
    cents: slice.cents,
    pct: Number.isFinite(slice.pct) ? Math.round(slice.pct * 100) / 100 : percentage(slice.cents, totalCents),
  }));
}

export interface BarsPoint {
  month: string;
  /** es-AR short label for the X axis, e.g. 'ene 26'. */
  label: string;
  incomeCents: number;
  expenseCents: number;
}

export function buildBarsData(rows: MonthlyTotal[]): BarsPoint[] {
  return rows.map((row) => ({
    month: row.month,
    label: shortMonthLabel(row.month),
    incomeCents: row.incomeCents ?? 0,
    expenseCents: row.expenseCents ?? 0,
  }));
}

export interface LinesPoint {
  month: string;
  /** es-AR short label for the X axis, e.g. 'ene 26'. */
  label: string;
  plannedCumCents: number;
  actualCumCents: number;
}

export function buildLinesData(rows: CumulativeBudgetPoint[]): LinesPoint[] {
  return rows.map((row) => ({
    month: row.month,
    label: shortMonthLabel(row.month),
    plannedCumCents: row.plannedCumCents ?? 0,
    actualCumCents: row.actualCumCents ?? 0,
  }));
}

/** False when every month of the window is zero (chart shows empty state). */
export function hasFlowData(rows: BarsPoint[]): boolean {
  return rows.some((row) => row.incomeCents !== 0 || row.expenseCents !== 0);
}

/** False when both cumulative curves stay flat at zero all year. */
export function hasCumulativeData(rows: LinesPoint[]): boolean {
  return rows.some((row) => row.plannedCumCents !== 0 || row.actualCumCents !== 0);
}
