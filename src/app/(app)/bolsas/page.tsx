import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { getPatrimony, listContributions, listGoals, listPendingRateReviews } from "@/features/savings/service";
import { listMembers } from "@/features/members/service";
import { goalEtaLabels } from "@/features/insights/projections";
import {
  addContributionAction,
  createGoalAction,
  deleteGoalAction,
  markRateReviewedAction,
  toggleGoalAction,
  updateGoalAction,
  updateGoalValueAction,
} from "@/features/savings/actions";
import BolsasPanel from "./bolsas-panel";

export default async function BolsasPage() {
  const user = await requireUser();
  // listGoals FIRST: it triggers the lazy interest catch-up, so the history
  // query below is guaranteed to see the freshly materialized entries.
  const goals = await listGoals(getDb());
  const [members, patrimony, contributions, pendingReviews, etaLabels] = await Promise.all([
    listMembers(getDb()),
    // Reuse the goals fetched above (they already triggered the catch-up):
    // patrimony is pure aggregation over them, no second goals query.
    getPatrimony(getDb(), goals),
    listContributions(getDb()),
    listPendingRateReviews(getDb()),
    // Derived projections (F4): one grouped contributions query, per-goal ETA copy.
    goalEtaLabels(getDb(), goals),
  ]);

  // One query for every card's collapsible history, grouped here.
  const contributionsByGoal: Record<string, typeof contributions> = {};
  for (const entry of contributions) {
    const list = contributionsByGoal[entry.goalId] ?? [];
    list.push(entry);
    contributionsByGoal[entry.goalId] = list;
  }

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Bolsas
      </h1>
      <BolsasPanel
        goals={goals}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
        isAdmin={user.role === "admin"}
        patrimony={{
          savingsCents: patrimony.savingsCents,
          investmentsCents: patrimony.investmentsCents,
          propertiesCents: patrimony.propertiesCents,
          totalCents: patrimony.totalCents,
        }}
        contributionsByGoal={contributionsByGoal}
        pendingReviews={pendingReviews}
        etaLabels={etaLabels}
        createAction={createGoalAction}
        updateAction={updateGoalAction}
        toggleAction={toggleGoalAction}
        deleteAction={deleteGoalAction}
        valueAction={updateGoalValueAction}
        contributionAction={addContributionAction}
        markReviewedAction={markRateReviewedAction}
      />
    </section>
  );
}
