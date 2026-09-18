import type { ProgressStatus } from "@/features/budgets/progress";

/**
 * Shared monthly-progress bar (budget page + envelope cards). Width is the
 * percentage capped at 100%; color comes from the shared status thresholds
 * (ok / warn >= 75% / over >= 100%) so every screen agrees on the semantics.
 */
const STATUS_CLASS: Record<ProgressStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  over: "bg-red-500",
};

export function ProgressBar({ pct, status }: { pct: number; status: ProgressStatus }) {
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div
      role="progressbar"
      aria-valuenow={width}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
    >
      <div
        className={`h-full rounded-full transition-[width] ${STATUS_CLASS[status]}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
