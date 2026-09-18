import { describe, expect, it } from "vitest";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";

/**
 * Regression tests for production error shape handling. The delete-blocker
 * detection must work for BOTH driver shapes:
 *
 * - postgres.js over TCP (production): drizzle wraps the driver's
 *   PostgresError in a "Failed query" error, SQLSTATE sits on
 *   `error.cause.code` (verified against Vercel runtime logs).
 * - PGlite (test/integration): the Postgres error also arrives wrapped by
 *   drizzle, but the code may sit directly on the error or one cause deep.
 */
describe("pg error shape matching", () => {
  describe("hasPgError (code lookup across driver shapes)", () => {
    it("matches a postgres.js style error with the code directly on the error", () => {
      expect(hasPgError({ code: "23503" }, "23503")).toBe(true);
    });

    it("matches a drizzle-wrapped error with the code on its cause (production shape)", () => {
      const productionShape = {
        message: 'Failed query: delete from "categories" where "categories"."id" = $1',
        query: 'delete from "categories"',
        params: ["a3a79fbf-cc8c-4bac-8987-6fa7464e8775"],
        cause: {
          severity: "ERROR",
          code: "23503",
          detail: 'Key (id)=(...) is still referenced from table "budgets".',
          constraint_name: "budgets_category_id_categories_id_fk",
        },
      };
      expect(hasPgError(productionShape, "23503")).toBe(true);
    });

    it("does not match when the code differs or is missing", () => {
      expect(hasPgError({ code: "23505" }, "23503")).toBe(false);
      expect(hasPgError({ cause: { code: "23505" } }, "23503")).toBe(false);
      expect(hasPgError({ message: "boom" }, "23503")).toBe(false);
      expect(hasPgError({ cause: {} }, "23503")).toBe(false);
    });

    it("does not throw on non-error inputs", () => {
      expect(hasPgError(null, "23503")).toBe(false);
      expect(hasPgError(undefined, "23503")).toBe(false);
      expect(hasPgError("plain string", "23503")).toBe(false);
    });
  });

  describe("hasPgFkError (delete blockers)", () => {
    it("matches restrict_violation 23001 in both shapes", () => {
      expect(hasPgFkError({ code: "23001" })).toBe(true);
      expect(hasPgFkError({ cause: { code: "23001" } })).toBe(true);
    });

    it("matches foreign_key_violation 23503 in both shapes (PG 17 production)", () => {
      expect(hasPgFkError({ code: "23503" })).toBe(true);
      expect(hasPgFkError({ cause: { code: "23503" } })).toBe(true);
    });

    it("does not treat non-FK errors as delete blockers", () => {
      expect(hasPgFkError({ code: "23505" })).toBe(false);
      expect(hasPgFkError({ code: "23514" })).toBe(false);
      expect(hasPgFkError(new Error("boom"))).toBe(false);
    });
  });
});
