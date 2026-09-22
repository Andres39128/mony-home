/**
 * Receipt image serving — the app's only route handler.
 *
 * Private user data: every request goes through requireUser and an ownership
 * check (own movement, or admin — same rule as the transactions service).
 * Missing and foreign receipts both answer 404 so existence never leaks.
 * The receipt id in the URL is a UUID, checked before it reaches Postgres.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { movementReceipts, transactions } from "@/db/schema";
import { requireUser } from "@/features/auth/session";
import { UUID_RE } from "@/features/transactions/service";

const notFound = () => new Response(null, { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const user = await requireUser();

  const [row] = await getDb()
    .select({
      bytes: movementReceipts.bytes,
      mimeType: movementReceipts.mimeType,
      memberId: transactions.memberId,
    })
    .from(movementReceipts)
    .innerJoin(transactions, eq(movementReceipts.transactionId, transactions.id))
    .where(eq(movementReceipts.id, id))
    .limit(1);

  if (!row || (user.role !== "admin" && row.memberId !== user.id)) return notFound();

  // private, no-store: the image is household-private and session-scoped.
  return new Response(new Uint8Array(row.bytes), {
    headers: {
      "Content-Type": row.mimeType,
      "Cache-Control": "private, no-store",
    },
  });
}
