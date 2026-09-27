import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import {
  listCardCycles,
  listLoanPeriods,
  listLoans,
  listPayments,
} from "@/features/loans/service";
import { listMembers } from "@/features/members/service";
import {
  addCardPaymentAction,
  addLoanPaymentAction,
  createLoanAction,
  deleteLoanAction,
  removeLedgerEntryAction,
  toggleLoanAction,
  updateLoanAction,
  updateOutstandingAction,
} from "@/features/loans/actions";
import LoansPanel from "./loans-panel";

export default async function PrestamosPage() {
  const user = await requireUser();
  // listLoans FIRST: it triggers the lazy interest catch-up, so the queries
  // below are guaranteed to see the freshly materialized entries.
  const loans = await listLoans(getDb());
  const bankIds = loans.filter((loan) => loan.amortizationMode === "bank").map((loan) => loan.id);
  const cardIds = loans
    .filter((loan) => loan.amortizationMode === "revolving")
    .map((loan) => loan.id);
  const [members, payments, bankPeriodLists, cardCycleLists] = await Promise.all([
    listMembers(getDb()),
    listPayments(getDb()),
    // Statement breakdown per bank loan (D5); listLoanPeriods only groups
    // what listLoans already materialized above.
    Promise.all(bankIds.map((id) => listLoanPeriods(getDb(), id))),
    // Billing-cycle breakdown per revolving card (statement_day grouping).
    Promise.all(cardIds.map((id) => listCardCycles(getDb(), id))),
  ]);

  // One query for every card's collapsible history, grouped here.
  const paymentsByLoan: Record<string, typeof payments> = {};
  for (const entry of payments) {
    const list = paymentsByLoan[entry.loanId] ?? [];
    list.push(entry);
    paymentsByLoan[entry.loanId] = list;
  }
  const periodsByLoan: Record<string, (typeof bankPeriodLists)[number]> = {};
  for (const [index, id] of bankIds.entries()) {
    periodsByLoan[id] = bankPeriodLists[index]!;
  }
  const cyclesByLoan: Record<string, (typeof cardCycleLists)[number]> = {};
  for (const [index, id] of cardIds.entries()) {
    cyclesByLoan[id] = cardCycleLists[index]!;
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
        periodsByLoan={periodsByLoan}
        cyclesByLoan={cyclesByLoan}
        createAction={createLoanAction}
        updateAction={updateLoanAction}
        toggleAction={toggleLoanAction}
        deleteAction={deleteLoanAction}
        outstandingAction={updateOutstandingAction}
        paymentAction={addLoanPaymentAction}
        cardPaymentAction={addCardPaymentAction}
        removeEntryAction={removeLedgerEntryAction}
      />
    </section>
  );
}
