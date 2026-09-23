/**
 * assistant-eval — empirical model validation for the finance assistant.
 *
 * Asks the SAME four Spanish questions to THREE free-tier OpenRouter models
 * over the REAL finance context built from a database, then compares latency
 * and numeric groundedness (amounts in the answers that do NOT appear in the
 * context are flagged for manual review). Owner ops tool: committed, zero
 * extra dependencies, runs with plain node.
 *
 * USAGE (throwaway database, like previous phases):
 *
 *   podman run -d --name mony-eval-pg -e POSTGRES_PASSWORD=eval \
 *     -p 55432:5432 postgres:17-alpine
 *   DATABASE_URL=postgresql://postgres:eval@localhost:55432/postgres \
 *   DIRECT_URL=postgresql://postgres:eval@localhost:55432/postgres \
 *     npm run db:migrate && \
 *   DATABASE_URL=postgresql://postgres:eval@localhost:55432/postgres \
 *     npm run db:seed
 *   DATABASE_URL=postgresql://postgres:eval@localhost:55432/postgres \
 *     node --env-file-if-exists=.env.local --import ./scripts/alias-loader.mjs \
 *     scripts/assistant-eval.ts
 *   podman rm -f mony-eval-pg
 *
 * Notes:
 * - LLM_API_KEY/LLM_MODEL come from .env.local; the key is only sent as the
 *   Authorization header and is never printed.
 * - Inline DATABASE_URL overrides .env.local (process env wins over env
 *   files), so the eval never touches the production database.
 * - Fires ~12 requests total: within the 50 req/day free-tier budget.
 */
import { performance } from "node:perf_hooks";
import { getConfig } from "@/lib/config";
import { getDb, closeDb } from "@/db";
import { todayIso } from "@/lib/date";
import { buildFinanceContext, toPromptContext } from "@/features/insights/context";
import { buildAssistantMessages } from "@/features/assistant/service";
import { chatCompletion } from "@/features/assistant/llm";

const MODELS = [
  "deepseek/deepseek-v4-flash-0731:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "openrouter/free",
] as const;

const QUESTIONS = [
  "¿Cómo venimos con el presupuesto de este mes?",
  "¿En qué categoría me estoy pasando y cuánto?",
  "¿Cómo se compara este mes con el promedio?",
  "¿Qué consejo darías para el mes que viene?",
] as const;

/** Operator annotations per model+question (manual review notes). */
const NOTES: Record<string, string> = {
  // "deepseek/deepseek-v4-flash-0731:free|2": "cifró bien el gasto de Ocio",
};

// Amount-like tokens: $-prefixed numbers always count; bare numbers must
// carry es-AR thousands groups ("1.234,56") and must not end in %. The
// trailing lookahead rejects ANY backtracked prefix of a percentage.
const AMOUNT_RE = /\$\s?\d[\d.,]*|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?(?![\d.,]*\s*%)/g;

function normalize(text: string): string {
  return text.replace(/[\s\u00A0$]/g, "");
}

/** Amount-like tokens in `text` that don't appear verbatim in `known`. */
function unknownAmounts(text: string, known: Set<string>): string[] {
  const flagged = new Set<string>();
  for (const token of text.match(AMOUNT_RE) ?? []) {
    const value = normalize(token);
    if (value.length === 0) continue;
    if (![...known].some((candidate) => candidate === value)) flagged.add(token.trim());
  }
  return [...flagged];
}

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.DATABASE_URL) {
    console.error(
      "DATABASE_URL is required. Point it at a THROWAWAY database (see the header of scripts/assistant-eval.ts).",
    );
    process.exitCode = 1;
    return;
  }

  const month = todayIso().slice(0, 7);
  const db = getDb();
  const context = await buildFinanceContext(db, month);
  const promptJson = JSON.stringify(toPromptContext(context));

  console.log(`Contexto construido para ${context.monthLabel} (${context.month}):`);
  console.log(promptJson);

  // Every formatted amount AND percentage in the context counts as "known"
  // (models legitimately reformat "+1099,98%" as "+1.099,98%").
  const known = new Set<string>();
  for (const token of promptJson.match(/"\$[^"]+"|\d+(?:[.,]\d+)?%/g) ?? []) {
    known.add(normalize(token.replace(/"/g, "")));
  }

  const today = todayIso();
  const results: { model: string; question: number; latencyMs: number; flagged: number; ok: boolean }[] =
    [];

  for (const model of MODELS) {
    console.log(`\n${"=".repeat(72)}\nMODELO: ${model}\n${"=".repeat(72)}`);
    let answered = 0;
    let totalLatency = 0;

    for (const [index, question] of QUESTIONS.entries()) {
      const messages = buildAssistantMessages(context, question, [], today, config.APP_NAME);
      const startedAt = performance.now();
      const result = await chatCompletion({ messages, model });
      const latencyMs = Math.round(performance.now() - startedAt);

      if (result.ok) {
        answered += 1;
        totalLatency += latencyMs;
        const flagged = unknownAmounts(result.content, known);
        results.push({ model, question: index + 1, latencyMs, flagged: flagged.length, ok: true });
        console.log(`\nQ${index + 1}: "${question}"  [${latencyMs} ms]`);
        console.log(`  ${result.content.replace(/\n+/g, " ")}`);
        if (flagged.length > 0) {
          console.log(`  ⚠ cifras no presentes en el contexto: ${flagged.join(" | ")}`);
        }
        const note = NOTES[`${model}|${index + 1}`];
        if (note) console.log(`  nota manual: ${note}`);
      } else {
        results.push({ model, question: index + 1, latencyMs, flagged: 0, ok: false });
        console.log(`\nQ${index + 1}: "${question}"  [${latencyMs} ms]`);
        console.log(`  ERROR: ${result.error}${result.retryAfterSeconds ? ` (retry-after ${result.retryAfterSeconds}s)` : ""}`);
      }
    }
    console.log(
      `\n→ ${model}: ${answered}/${QUESTIONS.length} respuestas, latencia media ${answered ? Math.round(totalLatency / answered) : "—"} ms`,
    );
  }

  console.log(`\n${"=".repeat(72)}\nRESUMEN COMPARATIVO\n${"=".repeat(72)}`);
  console.log("modelo | Q | latencia | cifras dudosas");
  for (const row of results) {
    console.log(
      `${row.model} | Q${row.question} | ${row.ok ? `${row.latencyMs} ms` : "error"} | ${row.ok ? row.flagged : "—"}`,
    );
  }

  if (!results.some((row) => row.ok)) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error("eval failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
