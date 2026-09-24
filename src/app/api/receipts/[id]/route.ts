/**
 * Receipt image serving — the app's only route handler.
 *
 * Thin HTTP adapter over the transactions service: UUID guard, auth, then
 * the ownership check lives in getReceiptFile (own movement, or admin — same
 * rule 6 as the rest of the transactions service). Missing and foreign
 * receipts both answer 404 so existence never leaks.
 */
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { UUID_RE, getReceiptFile } from "@/features/transactions/service";

const notFound = () => new Response(null, { status: 404 });

/** 'image/jpeg' → '.jpg'; only the allow-listed receipt MIME types reach here. */
function extensionFor(mimeType: string): string {
  return mimeType === "image/jpeg" ? ".jpg" : `.${mimeType.split("/")[1] ?? "bin"}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const user = await requireUser();
  const file = await getReceiptFile(getDb(), user, id);
  if (!file) return notFound();

  // private, no-store: the image is household-private and session-scoped.
  return new Response(file.bytes, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename="receipt${extensionFor(file.mimeType)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
