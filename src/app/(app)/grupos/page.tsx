import { requireUser } from "@/features/auth/session";
import { getDb } from "@/db";
import { listExpenseGroups } from "@/features/expense-groups/service";
import {
  createExpenseGroupAction,
  deleteExpenseGroupAction,
  setExpenseGroupStatusAction,
  updateExpenseGroupAction,
} from "@/features/expense-groups/actions";
import GroupsPanel from "./groups-panel";

export default async function GruposPage() {
  const user = await requireUser();
  const groups = await listExpenseGroups(getDb());

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Grupos
      </h1>
      <GroupsPanel
        groups={groups}
        isAdmin={user.role === "admin"}
        createAction={createExpenseGroupAction}
        updateAction={updateExpenseGroupAction}
        statusAction={setExpenseGroupStatusAction}
        deleteAction={deleteExpenseGroupAction}
      />
    </section>
  );
}
