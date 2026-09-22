import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("manifest", () => {
  const m = manifest();

  it("exposes the fields browsers require for installability", () => {
    expect(m.name).toBe("mony-home");
    expect(m.short_name).toBe("mony");
    expect(m.description).toBe("Finanzas del hogar");
    expect(m.id).toBe("/");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.background_color).toBe("#faf7f0");
    expect(m.theme_color).toBe("#ffe5a3");
    expect(m.lang).toBe("es");
  });

  it("declares 192 and 512 icons for both any and maskable purposes", () => {
    const byPurpose = (purpose: string) =>
      (m.icons ?? []).filter((icon) => icon.purpose === purpose);

    expect(byPurpose("any").map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(["192x192", "512x512"]),
    );
    expect(byPurpose("maskable").map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(["192x192", "512x512"]),
    );
    // Maskable icons must point at the dedicated padded variants.
    expect(byPurpose("maskable").map((icon) => icon.src)).toEqual([
      "/icon-maskable-192.png",
      "/icon-maskable-512.png",
    ]);
  });
});
