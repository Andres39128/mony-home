import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `server-only` throws outside the react-server condition; resolve it to
    // its no-op build so tests transitively touching src/db don't explode
    // (src/db/index.ts imports "server-only" at top level). NOTE: this
    // condition is GLOBAL — every test in the suite resolves react/next via
    // their server branches, not only DB-touching ones. Safe today because
    // all tests are .ts under environment: "node", but the first component
    // (.tsx) test must scope this first (e.g. vitest projects) or it will
    // silently render with server React.
    conditions: ["react-server"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
