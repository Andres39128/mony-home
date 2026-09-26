/**
 * Node module-resolution hook: maps `@/*` → `./src/*` for plain-node runs
 * (type stripping is native in Node ≥ 23). Needed because app modules import
 * each other with the `@/` alias and the eval script must reuse the REAL
 * code (context builder + adapter), not a copy. Zero dependencies.
 *
 * Usage: node --import ./scripts/alias-loader.mjs <script.ts>
 */
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    // "server-only" throws under Node's default condition (its index.js
    // exists to be imported only via the react-server condition), and
    // src/db/index.ts imports it at top level. Plain-node scripts must get
    // the package's empty build instead — same trick as vitest.config.ts
    // resolve.conditions. Direct file URL: the package exports only map "."
    // by condition, so "server-only/empty.js" is not resolvable as a
    // subpath import.
    if (specifier === "server-only") {
      return {
        url: new URL("../node_modules/server-only/empty.js", import.meta.url).href,
        shortCircuit: true,
      };
    }
    // App-alias imports: "@/db/schema" → <root>/src/db/schema(.ts).
    if (specifier.startsWith("@/")) {
      const base = new URL(specifier.slice(2), SRC);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, base.href]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // Try the next candidate shape (file.ts, dir/index.ts, exact).
        }
      }
    }
    // Bundler-style extensionless relative imports inside src ("./schema").
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/.test(specifier)) {
      const parent = context.parentURL;
      if (parent?.startsWith(SRC.href)) {
        for (const suffix of [".ts", "/index.ts"]) {
          try {
            return nextResolve(new URL(`${specifier}${suffix}`, parent).href, context);
          } catch {
            // Try the next candidate shape.
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
