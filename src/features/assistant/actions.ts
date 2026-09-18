"use server";

import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { ask, type AskResult, type HistoryTurn } from "@/features/assistant/service";

/**
 * Server Function for the chat UI. Auth is enforced here (reachable via
 * direct POST, not just through the page); the service owns validation,
 * quota and the LLM call. Plain-object args/return: both serializable.
 */
export async function askAssistantAction(
  question: string,
  history: HistoryTurn[],
): Promise<AskResult> {
  const user = await requireUser();
  return ask(getDb(), user, question, history);
}
