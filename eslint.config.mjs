import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Quality contract: `any` is forbidden. Type something properly instead.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // --- Layer boundaries (enforced by `npm run verify`) ---
  // A) src/app never touches drivers directly; the `@/db` entry point stays
  //    legal because it is the DI-at-call-site pattern (getDb + closeDb only).
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/*", "drizzle-orm", "drizzle-orm/*", "postgres"],
              message:
                'src/app must access data through feature services / lib. Only `getDb` from "@/db" is allowed.',
            },
          ],
        },
      ],
    },
  },
  // B) Features stay framework-agnostic: pure services take `db` as a
  //    parameter; Next.js glue lives only in actions.ts / auth/session.ts.
  //    `@/db` (the client) is restricted via `paths` — exact-name match:
  //    in a `group`, the bare `@/db` pattern has gitignore directory
  //    semantics and would also forbid pure subpath modules such as
  //    `@/db/schema` and `@/db/pg-errors`, which carry no client or framework.
  {
    files: ["src/features/**/*.ts"],
    ignores: ["**/actions.ts", "src/features/auth/session.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/db",
              allowTypeImports: true,
              message:
                "Feature modules stay framework-agnostic: take `db` as a parameter; Next glue lives only in actions.ts / auth/session.ts. (Type-only imports are fine.)",
            },
          ],
          patterns: [
            {
              group: ["next", "next/*", "react", "react/*"],
              allowTypeImports: true,
              message:
                "Feature modules stay framework-agnostic: take `db` as a parameter; Next glue lives only in actions.ts / auth/session.ts. (Type-only imports are fine.)",
            },
          ],
        },
      ],
    },
  },
  // C) Client-facing components cannot reach server internals.
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/db",
                "@/db/*",
                "drizzle-orm",
                "drizzle-orm/*",
                "postgres",
                "@/lib/auth",
                "@/lib/config",
              ],
              message: "Client-facing components cannot reach server internals.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
