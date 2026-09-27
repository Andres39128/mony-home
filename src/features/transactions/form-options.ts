import type { Database } from "@/db";
import { listCategories, type CategoryView } from "@/features/categories/service";
import { listExpenseGroups, type ExpenseGroupView } from "@/features/expense-groups/service";
import { listMembers } from "@/features/members/service";
import { listLoans } from "@/features/loans/service";

/** An active revolving card the movement form can offer as payment method. */
export interface CardOption {
  id: string;
  name: string;
  /** Cupo disponible at render time (guidance only — the service re-checks). */
  availableCents: number;
}

/** Everything the movement form needs, fetched once for a server render. */
export interface MovementFormOptions {
  categories: CategoryView[];
  members: { id: string; name: string; isActive: boolean }[];
  groups: ExpenseGroupView[];
  /** Active revolving credit cards (empty when none are configured). */
  cards: CardOption[];
}

export async function movementFormOptions(db: Database): Promise<MovementFormOptions> {
  const [categories, members, groups, loans] = await Promise.all([
    listCategories(db),
    listMembers(db),
    listExpenseGroups(db),
    // listLoans is the single source of cupo math (and runs the lazy
    // catch-up first — cheap in steady state).
    listLoans(db),
  ]);
  return {
    categories,
    members: members.map((member) => ({
      id: member.id,
      name: member.name,
      isActive: member.isActive,
    })),
    groups,
    cards: loans
      .filter((loan) => loan.amortizationMode === "revolving" && loan.isActive)
      .map((loan) => ({
        id: loan.id,
        name: loan.name,
        availableCents: loan.availableCents ?? 0,
      })),
  };
}
