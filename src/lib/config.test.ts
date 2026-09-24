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
    // Seeding is a manual step: no default admin password anymore.
    expect(config.SEED_ADMIN_PASSWORD).toBeUndefined();
  });

  it("treats blank .env placeholders as unset (optional vars, defaults apply)", () => {
    const config = loadConfig({ DATABASE_URL: "", LLM_MODEL: "   ", APP_NAME: "" });

    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.LLM_MODEL).toBeUndefined();
    expect(config.APP_NAME).toBe("mony-home");
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

  it("defaults SEED_DEMO_DATA to true and parses 'false'", () => {
    expect(loadConfig({}).SEED_DEMO_DATA).toBe(true);
    expect(loadConfig({ SEED_DEMO_DATA: "" }).SEED_DEMO_DATA).toBe(true); // blank = unset
    expect(loadConfig({ SEED_DEMO_DATA: "true" }).SEED_DEMO_DATA).toBe(true);
    expect(loadConfig({ SEED_DEMO_DATA: "false" }).SEED_DEMO_DATA).toBe(false);
  });

  it("rejects SEED_DEMO_DATA values other than true/false", () => {
    // "yes"/"1" fail loudly instead of coercing to a surprising boolean.
    expect(() => loadConfig({ SEED_DEMO_DATA: "yes" })).toThrowError(/SEED_DEMO_DATA/);
    expect(() => loadConfig({ SEED_DEMO_DATA: "1" })).toThrowError(/SEED_DEMO_DATA/);
  });

  it("accepts a real SEED_ADMIN_PASSWORD and rejects too-short values", () => {
    expect(loadConfig({ SEED_ADMIN_PASSWORD: "real-password-9" }).SEED_ADMIN_PASSWORD).toBe(
      "real-password-9",
    );
    expect(() => loadConfig({ SEED_ADMIN_PASSWORD: "short" })).toThrowError(/SEED_ADMIN_PASSWORD/);
  });

  it("rejects the old changeme placeholder for SEED_ADMIN_PASSWORD", () => {
    expect(() => loadConfig({ SEED_ADMIN_PASSWORD: "changeme-on-first-login" })).toThrowError(
      /SEED_ADMIN_PASSWORD[\s\S]*placeholder/,
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
