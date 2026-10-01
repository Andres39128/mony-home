/**
 * Pure authorization rules shared across feature services. Client-safe by
 * design: services are imported (transitively) from client components for
 * their view types, so this module must never pull server-only code.
 */
import type { SessionUser } from "@/lib/auth";

/**
 * Member attribution shared by the movement/loan/goal services: an empty
 * memberId means the acting user; non-admins cannot target anyone else.
 */
export function resolveMemberId(
  user: SessionUser,
  memberId: string,
): { ok: true; memberId: string } | { ok: false; error: "forbidden" } {
  const resolved = memberId === "" ? user.id : memberId;
  if (user.role !== "admin" && resolved !== user.id) return { ok: false, error: "forbidden" };
  return { ok: true, memberId: resolved };
}
