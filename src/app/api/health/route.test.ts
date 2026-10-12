import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type Database } from "@/db";
import { GET } from "./route";

// The route touches the DB only through getDb(); mocking the module keeps
// the test hermetic (no postgres.js connection) — same approach the
// assistant tests take with "@/lib/config".
vi.mock("@/db", () => ({ getDb: vi.fn() }));

function mockDb(execute: ReturnType<typeof vi.fn>) {
  return vi.mocked(getDb).mockReturnValue({ execute } as unknown as Database);
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReset();
  });

  afterEach(() => {
    vi.mocked(getDb).mockRestore();
  });

  it("answers 200 ok when the database responds", async () => {
    mockDb(vi.fn().mockResolvedValue(undefined));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers 503 unavailable without leaking the DB error", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockDb(
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED db.supabase.internal")),
      );
      const response = await GET();
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const body = await response.json();
      expect(body).toEqual({ status: "unavailable" });
      expect(JSON.stringify(body)).not.toContain("supabase");
      // The cause still reaches the server log for the operator.
      expect(errorLog).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
    }
  });
});
