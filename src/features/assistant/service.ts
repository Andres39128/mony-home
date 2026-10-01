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
import { todayIso } from "@/lib/date";
import { getAppSettings, type AppSettings } from "@/lib/app-settings";
import { setDefaultCurrency } from "@/lib/money";
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
 * Human-readable currency label from the configured locale, e.g.
 * 'peso colombiano (COP)'. Falls back to the bare code if the runtime's ICU
 * does not know the currency — the prompt must never crash on a bad code
 * (zod already validated the shape, so this is belt-and-suspenders).
 */
function currencyLabel(settings: AppSettings): string {
  try {
    const name = new Intl.DisplayNames([settings.locale], { type: "currency" }).of(
      settings.currencyCode,
    );
    return name ? `${name.toLowerCase()} (${settings.currencyCode})` : settings.currencyCode;
  } catch {
    return settings.currencyCode;
  }
}

/**
 * Grounded system prompt: the model only narrates over the given context,
 * answers in neutral Spanish, and says so when a datum is missing. The
 * currency comes from the configured settings — never hardcoded.
 */
export function buildSystemPrompt(
  context: FinanceContext,
  today: string,
  appName: string,
  settings: AppSettings,
): string {
  return [
    `Eres el asistente financiero de ${appName}, una aplicación de finanzas del hogar.`,
    "Responde SIEMPRE en español neutro, de forma breve, clara y directa.",
    "",
    "Reglas obligatorias:",
    `- Usa ÚNICAMENTE los datos del contexto que aparece al final. No inventes ni calcules cifras: todos los montos ya vienen pre-calculados y formateados en la moneda del hogar (${currencyLabel(settings)}).`,
    "- Si el contexto no contiene el dato que te preguntan, dilo explícitamente y no lo estimes.",
    "- Al citar montos, copia tal cual los valores formateados del contexto (por ejemplo: $ 1.234,56).",
    "- Nunca ves movimientos individuales, solo agregados del hogar; no prometas ni pidas detalles que no estén en el contexto.",
    "- Para consejos, basate en el presupuesto, las bolsas, las deudas, las tarjetas de crédito, el patrimonio y la tendencia del contexto.",
    "- Sobre tarjetas: distinguí cupo (crédito disponible) de saldo pendiente; un saldo a favor significa que el banco le debe dinero al hogar. Los intereses de tarjeta se cargan manualmente al pagar.",
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
  settings: AppSettings,
): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(context, today, appName, settings) },
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

  // The configured currency drives BOTH the prompt wording and the amount
  // formatting of the context (toPromptContext → formatCents): server
  // actions run without the layout, so (re)set the module default here too.
  const settings = await getAppSettings(db);
  setDefaultCurrency(settings.currencyCode, settings.locale);

  const context = await buildFinanceContext(db, today.slice(0, 7), today);
  const messages = buildAssistantMessages(
    context,
    trimmed,
    sanitizeHistory(history),
    today,
    getConfig().APP_NAME,
    settings,
  );

  const result = await chatCompletion({ messages, fetchImpl: options.fetchImpl });
  if (!result.ok) return result;

  const count = await registerUse(db, user.id, today);
  const { ASSISTANT_DAILY_LIMIT: limit } = getConfig();
  return { ok: true, answer: result.content, remaining: Math.max(0, limit - count) };
}
