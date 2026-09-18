/**
 * Assistant service — the only path from a user question to an LLM answer.
 *
 * Flow: validate question → assert daily quota → build the deterministic
 * finance context (pre-computed aggregates, no raw transactions) → grounded
 * system prompt + last few history turns + question → OpenRouter adapter →
 * register quota use ONLY on success. Every failure is a typed code; the UI
 * phrases them in neutral Spanish and never shows a raw error.
 *
 * Non-streaming by approved design: one request, one answer, pending state
 * in the UI. History lives client-side; the server only receives the last
 * few turns and sanitizes them (server-action args are hostile input —
 * types are not enforced at runtime).
 */
import { getConfig } from "@/lib/config";
import type { Database } from "@/db";
import type { SessionUser } from "@/lib/auth";
import { todayIso } from "@/features/transactions/service";
import {
  buildFinanceContext,
  toPromptContext,
  type FinanceContext,
} from "@/features/insights/context";
import { assertQuota, registerUse } from "@/features/assistant/quota";
import {
  chatCompletion,
  type ChatMessage,
  type LlmErrorCode,
} from "@/features/assistant/llm";

/** Max question length accepted from the client. */
export const QUESTION_MAX_LENGTH = 500;
/** History turns sent to the model (spec: last ≤ 6). */
export const HISTORY_TURNS_SENT = 6;
/** Per-turn content clamp for the client-supplied history. */
export const HISTORY_TURN_MAX_CHARS = 2_000;

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export type AssistantError = "invalid_question" | "quota_exceeded" | LlmErrorCode;

export type AskResult =
  | { ok: true; answer: string; remaining: number }
  | { ok: false; error: AssistantError };

/** Trust boundary for client-supplied history: whitelist roles, clamp, keep the last turns. */
export function sanitizeHistory(history: HistoryTurn[] | unknown): HistoryTurn[] {
  if (!Array.isArray(history)) return [];
  const clean: HistoryTurn[] = [];
  for (const turn of history) {
    const role = (turn as HistoryTurn | null)?.role;
    const content = (turn as HistoryTurn | null)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const trimmed = content.trim().slice(0, HISTORY_TURN_MAX_CHARS);
    if (trimmed.length === 0) continue;
    clean.push({ role, content: trimmed });
  }
  return clean.slice(-HISTORY_TURNS_SENT);
}

/**
 * Grounded system prompt: the model only narrates over the given context,
 * answers in neutral Spanish, and says so when a datum is missing.
 */
export function buildSystemPrompt(
  context: FinanceContext,
  today: string,
  appName: string,
): string {
  return [
    `Eres el asistente financiero de ${appName}, una aplicación de finanzas del hogar.`,
    "Responde SIEMPRE en español neutro, de forma breve, clara y directa.",
    "",
    "Reglas obligatorias:",
    "- Usa ÚNICAMENTE los datos del contexto que aparece al final. No inventes ni calcules cifras: todos los montos ya vienen pre-calculados y formateados en pesos argentinos.",
    "- Si el contexto no contiene el dato que te preguntan, dilo explícitamente y no lo estimes.",
    "- Al citar montos, copia tal cual los valores formateados del contexto (por ejemplo: $ 1.234,56).",
    "- Nunca ves movimientos individuales, solo agregados del hogar; no prometas ni pidas detalles que no estén en el contexto.",
    "- Para consejos, basate en el presupuesto, las bolsas y la tendencia del contexto.",
    "",
    `Hoy es ${today}.`,
    "",
    "Contexto (JSON):",
    JSON.stringify(toPromptContext(context)),
  ].join("\n");
}

export function buildAssistantMessages(
  context: FinanceContext,
  question: string,
  history: HistoryTurn[],
  today: string,
  appName: string,
): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(context, today, appName) },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: question },
  ];
}

export interface AskOptions {
  /** Injectable day ('YYYY-MM-DD') for deterministic tests. */
  today?: string;
  /** Injectable fetch passthrough for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Answers one question against the CURRENT month's context.
 * The daily counter increments only when the model actually answered.
 */
export async function ask(
  db: Database,
  user: SessionUser,
  question: string,
  history: HistoryTurn[] = [],
  options: AskOptions = {},
): Promise<AskResult> {
  const today = options.today ?? todayIso();
  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > QUESTION_MAX_LENGTH) {
    return { ok: false, error: "invalid_question" };
  }

  const quota = await assertQuota(db, user.id, today);
  if (!quota.ok) return quota;

  const context = await buildFinanceContext(db, today.slice(0, 7), today);
  const messages = buildAssistantMessages(
    context,
    trimmed,
    sanitizeHistory(history),
    today,
    getConfig().APP_NAME,
  );

  const result = await chatCompletion({ messages, fetchImpl: options.fetchImpl });
  if (!result.ok) return result;

  const count = await registerUse(db, user.id, today);
  const { ASSISTANT_DAILY_LIMIT: limit } = getConfig();
  return { ok: true, answer: result.content, remaining: Math.max(0, limit - count) };
}
