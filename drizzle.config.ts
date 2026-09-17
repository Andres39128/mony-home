import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";
import { loadConfig } from "./src/lib/config.ts";

// Load .env.local (then .env) into process.env using Node's built-in loader so
// every drizzle-kit subcommand (generate/migrate/studio) sees the connection
// strings. No dotenv dependency needed.
for (const envFile of [".env.local", ".env"]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const config = loadConfig();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  // Migrations run against the direct (non-pooled) connection.
  // Optional on purpose: `generate` is offline and needs no credentials.
  ...(config.DIRECT_URL ? { dbCredentials: { url: config.DIRECT_URL } } : {}),
});
