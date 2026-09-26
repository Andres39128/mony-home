import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Shared driver/client restriction, reused by blocks A and C: only the `@/db`
// entry point and lib internals may import the wire driver.
const DB_DRIVER_BAN = ["@/db/*", "drizzle-orm", "drizzle-orm/*", "postgres"];

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
              group: DB_DRIVER_BAN,
              message:
                'src/app must access data through feature services / lib. Only `getDb`/`closeDb` from "@/db" are allowed.',
            },
          ],
        },
      ],
    },
  },
  // B) Features stay framework-agnostic: pure services take `db` as a
  //    parameter; Next.js glue lives only in actions.ts / auth/session.ts.
  //    Server internals (`@/db` client, `@/lib/auth` core) are restricted via
  //    `paths` — exact-name matches: in a `group`, the bare `@/db` pattern has
  //    gitignore directory semantics and would also forbid pure subpath
  //    modules such as `@/db/schema` and `@/db/pg-errors`, which carry no
  //    client. Password/session helpers live in importable `@/lib/password`
  //    and `@/lib/sessions`. This half covers .tsx too: feature UI must not
  //    reach the DB client either. Test files are exempt — they wire the REAL
  //    auth/session internals against PGlite (dev-only coupling, not shipped).
  {
    files: ["src/features/**/*.{ts,tsx}"],
    ignores: ["**/actions.ts", "src/features/auth/session.ts", "**/*.test.ts"],
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
            {
              name: "@/lib/auth",
              allowTypeImports: true,
              message:
                "Features must not import the auth core: use @/lib/password (hashing/lockout) and @/lib/sessions (session rows); types may be imported. Next glue lives only in actions.ts / auth/session.ts.",
            },
          ],
        },
      ],
    },
  },
  // B2) The Next/React ban stays .ts-only (intentional): feature .tsx files
  //     ARE the UI and legitimately import react/next — only pure services
  //     and helpers must not.
  {
    files: ["src/features/**/*.ts"],
    ignores: ["**/actions.ts", "src/features/auth/session.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
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
              group: ["@/db", ...DB_DRIVER_BAN, "@/lib/auth", "@/lib/config"],
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
