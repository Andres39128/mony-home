/**
 * OpenRouter (OpenAI-compatible) chat adapter — plain fetch, no SDK.
 *
 * Typed degradation only: every failure maps to a closed error code the UI
 * can phrase in neutral Spanish. NO automatic retries — on 429 the free-tier
 * rate limit is honored via Retry-After (surfaced, never re-fired), and the
 * caller decides what to do. The API key never appears in any error result:
 * failures carry codes and Retry-After only.
 *
 * Non-streaming by approved design (pending state in the UI is the accepted
 * tradeoff for simplicity).
 */
import { getConfig } from "@/lib/config";

/** Hard ceiling for one completion; the controller aborts past it. */
export const LLM_TIMEOUT_MS = 60_000;

export type LlmErrorCode =
  | "auth_error" // 401 or missing key/model → "configuración incompleta"
  | "no_credits" // 402 → free tier exhausted pending a credit purchase
  | "rate_limited" // 429 → honor Retry-After, do NOT auto-retry
  | "provider_down" // 5xx, malformed payload or network failure
  | "timeout"; // aborted past LLM_TIMEOUT_MS

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LlmResult =
  | { ok: true; content: string }
  | { ok: false; error: LlmErrorCode; retryAfterSeconds?: number };

export interface ChatOptions {
  messages: ChatMessage[];
  /** Test/ops override; defaults to the configured LLM_MODEL. */
  model?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * POST {LLM_BASE_URL}/chat/completions with attribution headers
 * (HTTP-Referer + X-Title from APP_NAME, as OpenRouter documents).
 */
export async function chatCompletion({
  messages,
  model,
  timeoutMs = LLM_TIMEOUT_MS,
  fetchImpl = fetch,
}: ChatOptions): Promise<LlmResult> {
  const config = getConfig();
  // A missing key/model is a deployment problem; the admin-facing bucket is
  // auth_error ("configuración incompleta").
  if (!config.LLM_API_KEY || !config.LLM_MODEL) return { ok: false, error: "auth_error" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.LLM_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.APP_NAME,
        "X-Title": config.APP_NAME,
      },
      body: JSON.stringify({ model: model ?? config.LLM_MODEL, messages }),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401) return { ok: false, error: "auth_error" };
      if (response.status === 402) return { ok: false, error: "no_credits" };
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds
            : undefined,
        };
      }
      // 5xx and any other unexpected status: treat the provider as down.
      return { ok: false, error: "provider_down" };
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false, error: "provider_down" };
    return { ok: true, content };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    // Network-level failure (DNS, refused connection, reset).
    return { ok: false, error: "provider_down" };
  } finally {
    clearTimeout(timer);
  }
}
