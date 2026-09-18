"use client";

/**
 * "Presupuesto acumulado vs gasto acumulado" for the selected month's year.
 * Two legend-toggled lines; tooltips show exact formatCents values.
 */
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents, formatCentsCompact } from "@/lib/money";
import { SERIES_COLORS, type LinesPoint } from "@/features/analytics/transform";
import { ChartLegend, type LegendItem } from "./chart-legend";

const SERIES = [
  { key: "plannedCumCents", name: "Presupuesto", color: SERIES_COLORS.planned },
  { key: "actualCumCents", name: "Gasto acumulado", color: SERIES_COLORS.actual },
] as const;

export default function BudgetLines({ data }: { data: LinesPoint[] }) {
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

  return (
    <div className="flex flex-col">
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} fontSize={12} interval="preserveStartEnd" />
          <YAxis tickFormatter={formatCentsCompact} tickLine={false} width={56} fontSize={12} />
          <Tooltip formatter={(cents) => formatCents(Number(cents))} />
          {SERIES.map((series) => (
            <Line
              key={series.key}
              type="monotone"
              dataKey={series.key}
              name={series.name}
              stroke={series.color}
              strokeWidth={2}
              dot={{ r: 3 }}
              hide={hidden.has(series.key)}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <ChartLegend items={legendItems} hidden={hidden} onToggle={toggle} />
    </div>
  );
}
