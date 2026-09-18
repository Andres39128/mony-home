import { afterEach, describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({
  LLM_API_KEY: "sk-test-secret" as string | undefined,
  LLM_MODEL: "test/model" as string | undefined,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    LLM_BASE_URL: "https://llm.test/api/v1",
    APP_NAME: "mony-home",
    ASSISTANT_DAILY_LIMIT: 8,
    LLM_API_KEY: configState.LLM_API_KEY,
    LLM_MODEL: configState.LLM_MODEL,
  }),
}));

const { chatCompletion, LLM_TIMEOUT_MS } = await import("@/features/assistant/llm");
type LlmResult = Awaited<ReturnType<typeof chatCompletion>>;

const MESSAGES = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "¿cómo vamos?" },
] as const;

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

/** Fetch double that rejects when aborted (like a real hanging request). */
function hangingFetch(): typeof fetch {
  return ((_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as typeof fetch;
}

afterEach(() => {
  configState.LLM_API_KEY = "sk-test-secret";
  configState.LLM_MODEL = "test/model";
});

describe("llm adapter (mocked fetch)", () => {
  it("posts to the configured base URL with attribution headers and model", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: "Todo en orden" } }] }),
    );

    const result = await chatCompletion({ messages: [...MESSAGES], fetchImpl });

    expect(result).toEqual({ ok: true, content: "Todo en orden" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.test/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-secret");
    expect(headers["HTTP-Referer"]).toBe("mony-home");
    expect(headers["X-Title"]).toBe("mony-home");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "test/model",
      messages: [...MESSAGES],
    });
  });

  it.each([
    [401, "auth_error"],
    [402, "no_credits"],
    [500, "provider_down"],
    [502, "provider_down"],
    [503, "provider_down"],
    [400, "provider_down"],
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    const result = await chatCompletion({
      messages: [...MESSAGES],
      fetchImpl: async () => statusResponse(status),
    });
    expect(result).toEqual({ ok: false, error: expected });
  });

  it("maps 429 to rate_limited and surfaces Retry-After without auto-retrying", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(429, { "Retry-After": "30" }));
    const result = await chatCompletion({ messages: [...MESSAGES], fetchImpl });
    expect(result).toEqual({ ok: false, error: "rate_limited", retryAfterSeconds: 30 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry storms
  });

  it("maps 429 without a Retry-After header to rate_limited only", async () => {
    const result = await chatCompletion({
      messages: [...MESSAGES],
      fetchImpl: async () => statusResponse(429),
    });
    expect(result).toEqual({ ok: false, error: "rate_limited" });
  });

  it("maps a timeout past the abort deadline", async () => {
    const result = await chatCompletion({
      messages: [...MESSAGES],
      timeoutMs: 10,
      fetchImpl: hangingFetch(),
    });
    expect(result).toEqual({ ok: false, error: "timeout" });
  });

  it("exports the 60s default timeout constant", () => {
    expect(LLM_TIMEOUT_MS).toBe(60_000);
  });

  it("maps network failures to provider_down", async () => {
    const result = await chatCompletion({
      messages: [...MESSAGES],
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(result).toEqual({ ok: false, error: "provider_down" });
  });

  it("maps a malformed payload to provider_down", async () => {
    const result = await chatCompletion({
      messages: [...MESSAGES],
      fetchImpl: async () => okResponse({ unexpected: true }),
    });
    expect(result).toEqual({ ok: false, error: "provider_down" });
  });

  it("reports auth_error when the key or model is not configured", async () => {
    const fetchImpl = vi.fn();
    configState.LLM_API_KEY = undefined;
    expect(await chatCompletion({ messages: [...MESSAGES], fetchImpl })).toEqual({
      ok: false,
      error: "auth_error",
    });
    configState.LLM_API_KEY = "sk-test-secret";
    configState.LLM_MODEL = undefined;
    expect(await chatCompletion({ messages: [...MESSAGES], fetchImpl })).toEqual({
      ok: false,
      error: "auth_error",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never leaks the API key in error results", async () => {
    const failures: LlmResult[] = [];
    failures.push(
      await chatCompletion({ messages: [...MESSAGES], fetchImpl: async () => statusResponse(401) }),
    );
    failures.push(
      await chatCompletion({
        messages: [...MESSAGES],
        timeoutMs: 10,
        fetchImpl: hangingFetch(),
      }),
    );
    failures.push(
      await chatCompletion({
        messages: [...MESSAGES],
        fetchImpl: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    );
    for (const result of failures) {
      expect(JSON.stringify(result)).not.toContain("sk-test-secret");
    }
  });
});
