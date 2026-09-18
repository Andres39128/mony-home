import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { listLoans, listPayments } from "@/features/loans/service";
import { listMembers } from "@/features/members/service";
import {
  addLoanPaymentAction,
  createLoanAction,
  deleteLoanAction,
  toggleLoanAction,
  updateLoanAction,
  updateOutstandingAction,
} from "@/features/loans/actions";
import LoansPanel from "./loans-panel";

export default async function PrestamosPage() {
  const user = await requireUser();
  // listLoans FIRST: it triggers the lazy interest catch-up, so the history
  // query below is guaranteed to see the freshly materialized entries.
  const loans = await listLoans(getDb());
  const [members, payments] = await Promise.all([
    listMembers(getDb()),
    listPayments(getDb()),
  ]);

  // One query for every card's collapsible history, grouped here.
  const paymentsByLoan: Record<string, typeof payments> = {};
  for (const entry of payments) {
    const list = paymentsByLoan[entry.loanId] ?? [];
    list.push(entry);
    paymentsByLoan[entry.loanId] = list;
  }

  const activeCount = loans.filter((loan) => loan.isActive).length;
  const debtCents = loans.reduce(
    (total, loan) => total + Math.max(loan.outstandingCents, 0),
    0,
  );

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Préstamos
      </h1>
      <LoansPanel
        loans={loans}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
        isAdmin={user.role === "admin"}
        summary={{ debtCents, activeCount }}
        paymentsByLoan={paymentsByLoan}
        createAction={createLoanAction}
        updateAction={updateLoanAction}
        toggleAction={toggleLoanAction}
        deleteAction={deleteLoanAction}
        outstandingAction={updateOutstandingAction}
        paymentAction={addLoanPaymentAction}
      />
    </section>
  );
}
