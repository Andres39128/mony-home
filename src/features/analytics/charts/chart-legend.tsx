"use client";

/**
 * Shared chart legend with click-to-toggle series. Recharts' built-in
 * legend loses entries when their series is hidden (can't be re-enabled),
 * so this custom one always renders every item with the current state.
 */
export interface LegendItem {
  key: string;
  label: string;
  color: string;
}

export function ChartLegend({
  items,
  hidden,
  onToggle,
}: {
  items: LegendItem[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-xs">
      {items.map((item) => {
        const isHidden = hidden.has(item.key);
        return (
          <li key={item.key}>
            <button
              type="button"
              aria-pressed={!isHidden}
              onClick={() => onToggle(item.key)}
              className={`flex items-center gap-1.5 rounded px-1 py-0.5 transition-opacity hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                isHidden ? "opacity-40 line-through" : ""
              }`}
            >
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              {item.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
