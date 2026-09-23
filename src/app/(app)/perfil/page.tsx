import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions } from "@/db/schema";
import { requireUser } from "@/features/auth/session";
import { changeOwnPasswordAction, updateOwnNameAction } from "@/features/members/actions";
import PerfilPanel from "./perfil-panel";

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

/**
 * Self-service account page: profile info + change own password / rename.
 * Session expiry is one indexed read — cheap enough to show a hint.
 */
export default async function PerfilPage() {
  const user = await requireUser();

  const [session] = await getDb()
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.userId, user.id))
    .orderBy(desc(sessions.expiresAt))
    .limit(1);

  const expiryLabel = session
    ? new Intl.DateTimeFormat("es-AR", { dateStyle: "long" }).format(session.expiresAt)
    : null;

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
    </section>
  );
}
