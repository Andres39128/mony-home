import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { savingsContributions, savingsGoals, users } from "@/db/schema";
import { listGoals } from "@/features/savings/service";
import {
  MAX_PROJECTION_MONTHS,
  goalEta,
  goalEtaLabel,
  goalEtaLabels,
  loanPayoffLabel,
  loanPayoffLabels,
  loanPayoffMonths,
  netContributionsByGoal,
} from "@/features/insights/projections";

const etaInput = (overrides: Partial<Parameters<typeof goalEta>[0]> = {}) => ({
  targetCents: 120_000,
  currentCents: 60_000,
  annualRateBp: null,
  accrualMode: null,
  avgNetContributionCents: 10_000,
  ...overrides,
});

describe("goalEta (pure)", () => {
  it("returns null for a goal without target", () => {
    expect(goalEta(etaInput({ targetCents: null }))).toBeNull();
  });

  it("returns 0 months when the target is already reached", () => {
    expect(goalEta(etaInput({ currentCents: 120_000 }))).toBe(0);
    expect(goalEta(etaInput({ currentCents: 130_000 }))).toBe(0);
  });

  it("is null when there is no rhythm (avg ≤ 0) and no interest", () => {
    expect(goalEta(etaInput({ avgNetContributionCents: 0 }))).toBeNull();
    expect(goalEta(etaInput({ avgNetContributionCents: -5_000 }))).toBeNull();
  });

  it("simulates simple TNA/12 + contributions month by month", () => {
    // 3550bp TNA → 0.02958… monthly on the running balance, +10.000/mes:
    // 60.000 → 71.775 → 83.898 → 96.380 → 109.231 → 122.462 ≥ 120.000.
    expect(
      goalEta(etaInput({ annualRateBp: 3550, accrualMode: "simple" })),
    ).toBe(5);
  });

  it("compounds with the TEA monthly root when mode is compound", () => {
    // 12% TEA → ~0.9489% monthly, no contributions: 1.000.000 crosses
    // 1.030.000 at month 4 (rounding of cents cannot flip this crossing).
    expect(
      goalEta(
        etaInput({
          targetCents: 1_030_000,
          currentCents: 1_000_000,
          annualRateBp: 1200,
          accrualMode: "compound",
          avgNetContributionCents: 0,
        }),
      ),
    ).toBe(4);
  });

  it("climbs from a negative balance when contributions cover it", () => {
    expect(goalEta(etaInput({ currentCents: -30_000 }))).not.toBeNull();
  });

  it("gives up after the iteration cap instead of looping forever", () => {
    const months = goalEta(
      etaInput({
        targetCents: 1_000_000_000,
        currentCents: 0,
        annualRateBp: null,
        avgNetContributionCents: 1_000,
      }),
    );
    expect(months).toBeNull();
    // Sanity: the same goal IS reachable inside the cap with a bigger rhythm.
    expect(MAX_PROJECTION_MONTHS).toBe(600);
  });
});

describe("loanPayoff (pure)", () => {
  it("rounds up to whole cuota months", () => {
    expect(loanPayoffMonths(250_000, 20_000)).toBe(13);
    expect(loanPayoffMonths(200_000, 20_000)).toBe(10);
  });

  it("is null without a positive cuota or without outstanding debt", () => {
    expect(loanPayoffMonths(250_000, null)).toBeNull();
    expect(loanPayoffMonths(250_000, 0)).toBeNull();
    expect(loanPayoffMonths(0, 20_000)).toBeNull();
    expect(loanPayoffMonths(-5_000, 20_000)).toBeNull();
  });

  it("labels only bank loans, as a lower-bound estimate", () => {
    const bank = { amortizationMode: "bank" as const, outstandingCents: 200_000, fixedCuotaCents: 20_000 };
    expect(loanPayoffLabel(bank, "2026-09-26")).toBe("Última cuota estimada: ~jul 2027");
    // Revolving (debt depends on usage) and any other mode → nothing.
    expect(
      loanPayoffLabel({ amortizationMode: "revolving", outstandingCents: 200_000, fixedCuotaCents: 20_000 }, "2026-09-26"),
    ).toBeNull();
    expect(loanPayoffLabel({ ...bank, fixedCuotaCents: null }, "2026-09-26")).toBeNull();
  });

  it("builds a loanId → copy map, nulls included", () => {
    expect(
      loanPayoffLabels(
        [
          { id: "a", amortizationMode: "bank", outstandingCents: 200_000, fixedCuotaCents: 20_000 },
          { id: "b", amortizationMode: "revolving", outstandingCents: 15_000, fixedCuotaCents: null },
        ],
        "2026-09-26",
      ),
    ).toEqual({ a: "Última cuota estimada: ~jul 2027", b: null });
  });
});

describe("goalEtaLabel (pure)", () => {
  const goal = (overrides: Partial<Parameters<typeof goalEtaLabel>[0]> = {}) => ({
    kind: "savings" as const,
    targetCents: 120_000 as number | null,
    netCents: 60_000,
    annualRateBp: null as number | null,
    accrualMode: null as "simple" | "compound" | null,
    ...overrides,
  });

  it("shows nothing for investments or target-less goals", () => {
    expect(goalEtaLabel(goal({ kind: "investment" }), 10_000, "2026-10-15")).toBeNull();
    expect(goalEtaLabel(goal({ targetCents: null }), 10_000, "2026-10-15")).toBeNull();
  });

  it("says when there is no rhythm yet", () => {
    expect(goalEtaLabel(goal({ avgNetContributionCents: 0 } as never), 0, "2026-10-15")).toBe(
      "Sin ritmo de aportes todavía",
    );
  });

  it("celebrates a reached target", () => {
    expect(goalEtaLabel(goal({ netCents: 130_000 }), 0, "2026-10-15")).toBe("Objetivo alcanzado");
  });

  it("projects the month label at the goal's rhythm", () => {
    // 3550bp simple + 10.000/mes → 5 months from 2026-10 → mar 2027.
    expect(goalEtaLabel(goal({ annualRateBp: 3550, accrualMode: "simple" }), 10_000, "2026-10-15")).toBe(
      "A este ritmo: ~mar 2027",
    );
  });
});

/**
 * Integration on PGlite: the grouped contributions query (window, interest
 * exclusion) plus the builder over REAL listGoals() views.
 */
describe("projections builder (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;

    const [user] = await db
      .insert(users)
      .values({ username: "andres", name: "Andrés", passwordHash: "x" })
      .returning();

    const [conRitmo] = await db
      .insert(savingsGoals)
      .values({ name: "Con ritmo", kind: "savings", scope: "common", targetCents: 200_000 })
      .returning();
    await db
      .insert(savingsGoals)
      .values({ name: "Sin meta", kind: "savings", scope: "common" });
    await db.insert(savingsGoals).values({ name: "Inversion", kind: "investment", scope: "common" });
    await db
      .insert(savingsGoals)
      .values({ name: "Frio", kind: "savings", scope: "common", targetCents: 50_000 });

    // Window for today=2026-10-15 is 2026-05-01..2026-10-15.
    await db.insert(savingsContributions).values([
      // Outside the window: counts for the ALL-TIME net, never for the rhythm.
      { goalId: conRitmo.id, memberId: user.id, kind: "deposit", amountCents: 99_999, date: "2026-04-20" },
      { goalId: conRitmo.id, memberId: user.id, kind: "deposit", amountCents: 20_000, date: "2026-08-10" },
      { goalId: conRitmo.id, memberId: user.id, kind: "deposit", amountCents: 30_000, date: "2026-09-05" },
      { goalId: conRitmo.id, memberId: user.id, kind: "withdrawal", amountCents: 10_000, date: "2026-09-20" },
      // Interest never counts as a contribution.
      { goalId: conRitmo.id, memberId: null, kind: "interest", amountCents: 5_000, date: "2026-09-30" },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("nets deposits − withdrawals per goal inside the trailing window", async () => {
    const nets = await netContributionsByGoal(appDb, "2026-10-15");
    expect(nets.size).toBe(1);
    expect(nets.get((await listGoals(appDb)).find((g) => g.name === "Con ritmo")!.id)).toBe(40_000);
  });

  it("builds per-goal ETA copy over real goal views", async () => {
    const goals = await listGoals(appDb);
    const labels = await goalEtaLabels(appDb, goals, "2026-10-15");
    const byName = new Map(goals.map((goal) => [goal.name, labels[goal.id]]));
    // All-time net 144.999 (incl. interest + out-of-window), rhythm 40.000/6 →
    // 9 months from 2026-10 → jul 2027.
    expect(byName.get("Con ritmo")).toBe("A este ritmo: ~jul 2027");
    expect(byName.get("Sin meta")).toBeNull();
    expect(byName.get("Inversion")).toBeNull();
    expect(byName.get("Frio")).toBe("Sin ritmo de aportes todavía");
  });
});
