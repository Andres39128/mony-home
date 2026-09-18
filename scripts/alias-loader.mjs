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
