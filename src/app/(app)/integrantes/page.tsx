import { requireUser } from "@/features/auth/session";
import { getDb } from "@/db";
import { listMembers } from "@/features/members/service";
import {
  createMemberAction,
  deleteMemberAction,
  updateMemberAction,
} from "@/features/members/actions";
import MembersPanel from "./members-panel";

export default async function IntegrantesPage() {
  const user = await requireUser();
  const members = await listMembers(getDb());

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Integrantes
      </h1>
      <MembersPanel
        members={members}
        isAdmin={user.role === "admin"}
        createAction={createMemberAction}
        updateAction={updateMemberAction}
        deleteAction={deleteMemberAction}
      />
    </section>
  );
}
