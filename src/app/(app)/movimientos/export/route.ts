/**
 * CSV export of movements — the app's second route handler.
 *
 * Private household data: requireUser runs before anything else. It shares
 * parseTransactionFilters with the /movimientos page, so an export URL is
 * always the filtered list the user is looking at (all matching rows, no
 * pagination). Answer marked private, no-store like the receipts route.
 */
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { listTransactions } from "@/features/transactions/service";
import { parseTransactionFilters } from "@/features/transactions/filters";
import { movementsToCsv } from "@/features/transactions/csv";

export async function GET(request: Request) {
  await requireUser();

  const url = new URL(request.url);
  const { filters } = parseTransactionFilters(Object.fromEntries(url.searchParams));
  const rows = await listTransactions(getDb(), filters);

  return new Response(movementsToCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="movimientos-${filters.month}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
