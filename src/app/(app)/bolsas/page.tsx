import { requireUser } from "@/features/auth/session";
import { getDb } from "@/db";
import { listEnvelopes, monthlyProgress } from "@/features/envelopes/service";
import { listMembers } from "@/features/members/service";
import {
  createEnvelopeAction,
  deleteEnvelopeAction,
  toggleEnvelopeAction,
  updateEnvelopeAction,
} from "@/features/envelopes/actions";
import EnvelopesPanel from "./envelopes-panel";

export default async function BolsasPage() {
  const user = await requireUser();
  const [envelopes, members, progress] = await Promise.all([
    listEnvelopes(getDb()),
    listMembers(getDb()),
    monthlyProgress(getDb()),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Bolsas
      </h1>
      <EnvelopesPanel
        envelopes={envelopes}
        progress={progress}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
        isAdmin={user.role === "admin"}
        createAction={createEnvelopeAction}
        updateAction={updateEnvelopeAction}
        toggleAction={toggleEnvelopeAction}
        deleteAction={deleteEnvelopeAction}
      />
    </section>
  );
}
