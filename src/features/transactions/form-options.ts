import { getDb } from "@/db";
import { listCategories, type CategoryView } from "@/features/categories/service";
import { listExpenseGroups, type ExpenseGroupView } from "@/features/expense-groups/service";
import { listMembers } from "@/features/members/service";

/** Everything the movement form needs, fetched once for a server render. */
export interface MovementFormOptions {
  categories: CategoryView[];
  members: { id: string; name: string; isActive: boolean }[];
  groups: ExpenseGroupView[];
}

export async function movementFormOptions(): Promise<MovementFormOptions> {
  const [categories, members, groups] = await Promise.all([
    listCategories(getDb()),
    listMembers(getDb()),
    listExpenseGroups(getDb()),
  ]);
  return {
    categories,
    members: members.map((member) => ({
      id: member.id,
      name: member.name,
      isActive: member.isActive,
    })),
    groups,
  };
}
