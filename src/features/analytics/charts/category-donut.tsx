"use client";

/**
 * "Gastos por categoría" donut. Clicking a SLICE drills into the auditable
 * movement list (/movimientos) filtered by that category, carrying every
 * active dashboard filter; legend items toggle slices on/off. Amounts in
 * the tooltip always go through formatCents.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatCents } from "@/lib/money";
import type { DonutSlice } from "@/features/analytics/transform";
import { ChartLegend, type LegendItem } from "./chart-legend";
import { chartPayload, withQueryParam } from "./payload";

export default function CategoryDonut({
  slices,
  totalCents,
  drillQuery,
}: {
  slices: DonutSlice[];
  totalCents: number;
  /** Active filters as a query string (without categoryId — the click adds it). */
  drillQuery: string;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(
    () => slices.filter((slice) => !hidden.has(slice.categoryId)),
    [slices, hidden],
  );
  const legendItems: LegendItem[] = slices.map((slice) => ({
    key: slice.categoryId,
    label: `${slice.name} · ${slice.pct}%`,
    color: slice.color,
  }));

  const toggle = (key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const drillToCategory = (event: { payload?: unknown }) => {
    const payload = chartPayload(event);
    if (typeof payload?.categoryId === "string") {
      router.push(`/movimientos?${withQueryParam(drillQuery, "categoryId", payload.categoryId)}`);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="relative">
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie
              data={visible}
              dataKey="cents"
              nameKey="name"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={2}
              strokeWidth={0}
              onClick={drillToCategory}
            >
              {visible.map((slice) => (
                <Cell key={slice.categoryId} fill={slice.color} cursor="pointer" />
              ))}
            </Pie>
            <Tooltip
              formatter={(cents) => {
                const value = Number(cents);
                const slice = visible.find((item) => item.cents === value);
                return `${formatCents(value)}${slice ? ` · ${slice.pct}%` : ""}`;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* Donut hole total: HTML overlay beats fighting SVG <text> sizing. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xs text-muted">Total gastado</span>
          <span className="text-lg font-semibold tabular-nums text-ink">
            {formatCents(totalCents)}
          </span>
        </div>
      </div>
      <ChartLegend items={legendItems} hidden={hidden} onToggle={toggle} />
    </div>
  );
}
