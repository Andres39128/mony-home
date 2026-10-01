import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { listActiveSessions } from "@/lib/auth";
import { changeOwnPasswordAction, updateOwnNameAction } from "@/features/members/actions";
import { setOpeningBalanceAction } from "@/features/transactions/actions";
import { findOpeningBalance } from "@/features/transactions/service";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/date";
import PerfilPanel from "./perfil-panel";
import OpeningBalanceCard from "./opening-balance-card";

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

/** Long es-AR label of a stored 'YYYY-MM-DD', safe from timezone shifts. */
function longDateLabel(iso: string): string {
  // Noon UTC keeps the America/Argentina/Buenos_Aires day on the stored date.
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "long" }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

/**
 * Self-service account page: profile info + change own password / rename.
 * Admins additionally anchor the household's saldo: the opening-balance card
 * shows the current system adjustment and rewrites it. Session expiry is one
 * indexed read — cheap enough to show a hint.
 */
export default async function PerfilPage() {
  const user = await requireUser();

  const [session] = await listActiveSessions(getDb(), user.id, 1);

  const expiryLabel = session
    ? new Intl.DateTimeFormat("es-AR", { dateStyle: "long" }).format(session.expiresAt)
    : null;

  const current = user.role === "admin" ? await findOpeningBalance(getDb()) : null;

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Perfil</h1>
      <PerfilPanel
        user={{
          name: user.name,
          username: user.username,
          role: ROLE_LABELS[user.role],
        }}
        sessionExpiry={expiryLabel}
        passwordAction={changeOwnPasswordAction}
        nameAction={updateOwnNameAction}
      />
      {user.role === "admin" && (
        <OpeningBalanceCard
          current={
            current && {
              signedLabel: formatCents(current.signedCents),
              dateLabel: longDateLabel(current.date),
            }
          }
          serverToday={todayIso()}
          action={setOpeningBalanceAction}
        />
      )}
    </section>
  );
}
