import { formatRatePercent } from "@/features/savings/math";

/**
 * Small badge pills shared by the panels (deduped from bolsas + préstamos,
 * which carried verbatim copies). No hooks: importable from both server and
 * client components.
 */

/** "Común" / "Individual · {member}" scope pill. */
export function ScopeBadge({
  scope,
  memberName,
}: {
  scope: "individual" | "common";
  memberName?: string | null;
}) {
  return scope === "common" ? (
    <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-medium text-ink">
      Común
    </span>
  ) : (
    <span className="rounded-full bg-honey px-2 py-0.5 text-xs font-medium text-ink">
      Individual · {memberName ?? "?"}
    </span>
  );
}

/**
 * Annual-rate pill: "TNA 35,5%" / "TEA 12%" — null rate renders nothing.
 * Mode label differs per feature: loans are nominal (TNA); savings goals may
 * be effective (TEA, compound) or nominal (TNA, simple).
 */
export function RateBadge({
  annualRateBp,
  mode,
}: {
  annualRateBp: number | null;
  mode: "TNA" | "TEA";
}) {
  if (annualRateBp === null) return null;
  return (
    <span className="rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-ink">
      {mode} {formatRatePercent(annualRateBp)}%
    </span>
  );
}
