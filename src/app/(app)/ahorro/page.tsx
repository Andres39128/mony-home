import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { getPatrimony, listGoals } from "@/features/savings/service";
import { listMembers } from "@/features/members/service";
import {
  addContributionAction,
  createGoalAction,
  deleteGoalAction,
  toggleGoalAction,
  updateGoalAction,
  updateGoalValueAction,
} from "@/features/savings/actions";
import SavingsPanel from "./savings-panel";

export default async function AhorroPage() {
  const user = await requireUser();
  const [goals, members, patrimony] = await Promise.all([
    listGoals(getDb()),
    listMembers(getDb()),
    getPatrimony(getDb()),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Ahorro
      </h1>
      <SavingsPanel
        goals={goals}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
        isAdmin={user.role === "admin"}
        patrimony={{
          savingsCents: patrimony.savingsCents,
          investmentsCents: patrimony.investmentsCents,
          totalCents: patrimony.totalCents,
        }}
        createAction={createGoalAction}
        updateAction={updateGoalAction}
        toggleAction={toggleGoalAction}
        deleteAction={deleteGoalAction}
        valueAction={updateGoalValueAction}
        contributionAction={addContributionAction}
      />
    </section>
  );
}
