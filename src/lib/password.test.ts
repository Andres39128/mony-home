import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";

/**
 * Minimal roundtrip check for the extracted credential primitives: a hash
 * from hashPassword verifies for the right password and rejects a wrong one.
 */
describe("password primitives", () => {
  it("hashPassword output verifies for the right password only", async () => {
    const hash = await hashPassword("correct-horse-1");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct-horse-1")).toBe(true);
    expect(await verifyPassword(hash, "wrong-horse-1")).toBe(false);
  });
});
