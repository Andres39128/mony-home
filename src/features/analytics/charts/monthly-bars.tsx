"use client";

/**
 * "Ingresos vs Gastos · últimos 12 meses". Two legend-toggled series;
 * clicking a BAR sets the dashboard month (all other filters stay).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents, formatCentsCompact } from "@/lib/money";
import { SERIES_COLORS, type BarsPoint } from "@/features/analytics/transform";
import { ChartLegend, type LegendItem } from "./chart-legend";
import { chartPayload, withQueryParam } from "./payload";

const SERIES = [
  { key: "incomeCents", name: "Ingresos", color: SERIES_COLORS.income },
  { key: "expenseCents", name: "Gastos", color: SERIES_COLORS.expense },
] as const;

export default function MonthlyBars({
  data,
  drillQuery,
}: {
  data: BarsPoint[];
  /** Active filters as a query string (without month — the click sets it). */
  drillQuery: string;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const legendItems: LegendItem[] = SERIES.map((series) => ({
    key: series.key,
    label: series.name,
    color: series.color,
  }));

  const toggle = (key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const drillToMonth = (event: { payload?: unknown }) => {
    const payload = chartPayload(event);
    if (typeof payload?.month === "string") {
      router.push(`/?${withQueryParam(drillQuery, "month", payload.month)}`);
    }
  };

  return (
    <div className="flex flex-col">
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} fontSize={12} interval="preserveStartEnd" />
          <YAxis tickFormatter={formatCentsCompact} tickLine={false} width={56} fontSize={12} />
          <Tooltip formatter={(cents) => formatCents(Number(cents))} cursor={{ fillOpacity: 0.06 }} />
          {SERIES.map((series) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              name={series.name}
              fill={series.color}
              hide={hidden.has(series.key)}
              radius={[3, 3, 0, 0]}
              cursor="pointer"
              onClick={drillToMonth}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <ChartLegend items={legendItems} hidden={hidden} onToggle={toggle} />
    </div>
  );
}
