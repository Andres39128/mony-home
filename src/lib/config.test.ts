import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, loadConfig } from "@/lib/config";

describe("loadConfig", () => {
  it("applies defaults when optional variables are absent", () => {
    const config = loadConfig({});

    expect(config.LLM_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(config.ASSISTANT_DAILY_LIMIT).toBe(8);
    expect(config.APP_NAME).toBe("mony-home");
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.LLM_API_KEY).toBeUndefined();
  });

  it("round-trips a valid override, coercing ASSISTANT_DAILY_LIMIT to a number", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/mony",
      ASSISTANT_DAILY_LIMIT: "12",
      APP_NAME: "mony-test",
    });

    expect(config.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/mony");
    expect(config.ASSISTANT_DAILY_LIMIT).toBe(12);
    expect(config.APP_NAME).toBe("mony-test");
  });

  it("throws naming the variable when ASSISTANT_DAILY_LIMIT is non-numeric", () => {
    expect(() => loadConfig({ ASSISTANT_DAILY_LIMIT: "abc" })).toThrowError(
      /ASSISTANT_DAILY_LIMIT/,
    );
  });

  it("rejects a non-positive ASSISTANT_DAILY_LIMIT", () => {
    expect(() => loadConfig({ ASSISTANT_DAILY_LIMIT: "0" })).toThrowError(
      /ASSISTANT_DAILY_LIMIT/,
    );
  });
});

describe("getConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws with an actionable message when the live env is invalid", () => {
    vi.stubEnv("ASSISTANT_DAILY_LIMIT", "not-a-number");
    expect(() => getConfig()).toThrowError(/ASSISTANT_DAILY_LIMIT/);
  });

  it("returns the same cached instance across calls", () => {
    expect(getConfig()).toBe(getConfig());
  });
});
