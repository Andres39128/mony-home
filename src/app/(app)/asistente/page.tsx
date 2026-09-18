import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { getQuota } from "@/features/assistant/quota";
import AssistantChat from "@/features/assistant/assistant-chat";

/**
 * Assistant page (server): renders the quota snapshot server-side and hands
 * it to the chat as the initial value; the client refreshes it from every
 * successful response.
 */
export default async function AssistantPage() {
  const user = await requireUser();
  const quota = await getQuota(getDb(), user.id);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">Asistente</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Preguntas y respuestas sobre las finanzas del hogar de este mes.
        </p>
      </header>
      <AssistantChat initialRemaining={quota.remaining} limit={quota.limit} />
    </section>
  );
}
