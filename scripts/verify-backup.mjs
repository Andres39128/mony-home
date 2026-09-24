#!/usr/bin/env node
/**
 * Backup restore drill — proves the weekly backup artifact is actually
 * restorable, not merely that a file exists.
 *
 * 1. Finds the latest successful `backup` workflow run (gh CLI).
 * 2. Downloads its db-backup-* artifact and decompresses the SQL dump.
 * 3. Replays the dump's `public` schema into a THROWAWAY in-memory PGlite
 *    (bare — NO project migrations; the dump carries its own schema).
 * 4. Asserts core tables (users, transactions, savings_goals) hold rows and
 *    prints a pass/fail report.
 *
 * ponytail: best-effort household ops, not enterprise. Two documented
 * ceilings: (a) the artifact is a FULL Supabase dump whose auth/storage/
 * realtime objects vanilla PGlite cannot host, so ONLY the `public` schema
 * is extracted — full-fidelity restores use psql + a fresh Postgres
 * (README "Backups"); (b) PGlite cannot run COPY FROM STDIN, so data blocks
 * are replayed as parameterized INSERTs typed via information_schema.
 *
 * Usage: npm run backup:verify
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";

const CORE_TABLES = ["users", "transactions", "savings_goals"];

/**
 * BACKUP_VERIFY_STRICT=1 (CI): gh missing/unauthenticated exits 1 instead of
 * 0 — a drill that never ran protects nothing. Default stays 0: locally, no
 * gh is an environment limit, not a backup failure (manual steps printed).
 */
const STRICT = process.env.BACKUP_VERIFY_STRICT === "1";

/** Manual steps printed when gh is unavailable (the drill exits 0 then). */
const MANUAL_STEPS = `
Manual restore check (README "Backups"):
  1. gh run list --workflow=backup.yml            # pick a successful run
  2. gh run download <run-id>                     # unpacks db-backup-YYYY-MM-DD/
  3. gunzip db-backup-YYYY-MM-DD/backup-YYYY-MM-DD.sql.gz
  4. Load into any throwaway Postgres:
     psql "postgresql://..." -f backup-YYYY-MM-DD.sql   # fresh/empty DB
  5. Check: SELECT count(*) FROM users; -- > 0 (also transactions, savings_goals)
`;

function fail(message) {
  console.error(`✗ ${message}`);
}

/** Runs gh with args; returns stdout or null when gh is missing/unauthenticated. */
function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function latestSuccessfulBackupRun() {
  const out = gh([
    "run", "list", "--workflow=backup.yml", "--status=success", "--limit=1",
    "--json", "databaseId,createdAt",
  ]);
  if (out === null) return { unavailable: true };
  const runs = JSON.parse(out);
  return { run: runs[0] ?? null };
}

function downloadArtifact(runId) {
  const dir = mkdtempSync(join(tmpdir(), "backup-drill-"));
  const out = gh(["run", "download", String(runId), "--dir", dir]);
  if (out === null) throw new Error("gh run download failed (network? artifact expired after 90 days?)");
  return dir;
}

function findSqlGz(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith(".sql.gz")) return full;
    }
  }
  throw new Error("no *.sql.gz found inside the artifact");
}

/**
 * Extracts the `public` schema plus the COPY data blocks from a plain
 * pg_dump. FK constraints are returned SEPARATELY (post) and applied AFTER
 * the data, mirroring pg_dump's own ordering: the dump's COPY blocks are
 * alphabetical, not dependency-ordered, so loading them with FKs already
 * in place would violate them (assistant_usage before users).
 * Everything else (auth/storage/realtime schemas, functions, grants) is
 * skipped: vanilla PGlite cannot host it.
 */
export function extractPublicDump(sql) {
  const pre = [];
  const post = []; // FK constraints — created after the data load
  const tables = []; // { table, columns, rows: string[][] }
  const lines = sql.split("\n");

  const SINGLE_LINE_PREFIX =
    /^(CREATE TYPE public\.|CREATE TABLE public\.|ALTER TABLE (ONLY )?public\.)/;
  // Indexes are named per schema: only those ON a public table qualify.
  const INDEX_LINE = /^CREATE (UNIQUE )?INDEX .* ON public\./;

  let pending = null; // multi-line DDL being accumulated
  let currentCopy = null; // { table, columns, rows }

  const pushDdl = (statement) => {
    if (/ADD CONSTRAINT .* FOREIGN KEY/.test(statement)) post.push(statement);
    else pre.push(statement);
  };

  for (const line of lines) {
    if (currentCopy) {
      if (line === "\\.") {
        tables.push(currentCopy);
        currentCopy = null;
      } else {
        currentCopy.rows.push(line.split("\t"));
      }
      continue;
    }
    if (pending) {
      pending.push(line);
      if (line.trimEnd().endsWith(";")) {
        pushDdl(pending.join("\n"));
        pending = null;
      }
      continue;
    }
    const copyMatch = /^COPY (public\.[A-Za-z0-9_]+) \((.*)\) FROM stdin;$/.exec(line);
    if (copyMatch) {
      currentCopy = {
        table: copyMatch[1],
        columns: copyMatch[2].split(",").map((name) => name.trim().replace(/^"|"$/g, "")),
        rows: [],
      };
      continue;
    }
    if (SINGLE_LINE_PREFIX.test(line) || INDEX_LINE.test(line)) {
      // Handles both single-line statements and multi-line ones (CREATE TYPE
      // ENUM blocks span lines); a statement is complete at a trailing ';'.
      if (line.trimEnd().endsWith(";")) pushDdl(line);
      else pending = [line];
    }
  }
  return { pre, post, tables };
}

/** COPY text-format field unescaping (\\N NULL handled by the caller). */
export function unescapeCopyField(field) {
  let out = "";
  for (let i = 0; i < field.length; i++) {
    const char = field[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = field[++i];
    switch (next) {
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "\\": out += "\\"; break;
      default: out += char + next; // unknown escape: keep verbatim
    }
  }
  return out;
}

/** Hex COPY bytea ("\\x504b...") → bytes for a PGlite parameter. */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function restoreIntoPglite({ pre, post, tables }) {
  // No-arg constructor = in-memory (a string like ":memory:" would be a
  // FILE PATH — PGlite would happily persist a data dir named that).
  const client = new PGlite();
  try {
    for (const statement of pre) await client.exec(statement);

    // Column types decide how COPY values become parameters (PGlite coerces
    // strings contextually; bytea needs real bytes).
    const { rows: columns } = await client.query(
      "select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'",
    );
    const typeByColumn = new Map(
      columns.map((c) => [`${c.table_name}.${c.column_name}`, c.data_type]),
    );

    let restoredRows = 0;
    for (const { table, columns: copyColumns, rows } of tables) {
      const tableName = table.slice("public.".length);
      const types = copyColumns.map((name) => typeByColumn.get(`${tableName}.${name}`));
      const placeholders = copyColumns.map((_, i) => `$${i + 1}`).join(", ");
      const insert = `insert into ${table} (${copyColumns.join(", ")}) values (${placeholders})`;
      for (const row of rows) {
        const values = row.map((raw, i) => {
          if (raw === "\\N") return null;
          const value = unescapeCopyField(raw);
          return types[i] === "bytea" ? hexToBytes(value.slice(2)) : value;
        });
        await client.query(insert, values);
        restoredRows++;
      }
    }

    // FKs last (pg_dump's own ordering): validate them over the loaded data.
    for (const statement of post) await client.exec(statement);
    return { client, restoredRows, tableCount: tables.length };
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function main() {
  const { unavailable, run } = latestSuccessfulBackupRun();
  if (unavailable) {
    console.log("gh CLI is unavailable or not authenticated — cannot download the artifact.");
    console.log(MANUAL_STEPS);
    // best-effort drill by default; strict mode (CI) fails so a silently
    // skipped drill can't pass the pipeline.
    process.exitCode = STRICT ? 1 : 0;
    return;
  }
  if (!run) {
    fail("No successful backup workflow run found — backups have never succeeded (or artifacts expired after 90 days).");
    console.log(MANUAL_STEPS);
    process.exitCode = 1;
    return;
  }
  console.log(`Latest successful backup run: ${run.databaseId} (${run.createdAt})`);

  let dir;
  try {
    dir = downloadArtifact(run.databaseId);
    const dumpFile = findSqlGz(dir);
    console.log(`Artifact dump: ${dumpFile}`);
    const sql = gunzipSync(readFileSync(dumpFile)).toString("utf8");

    const extracted = extractPublicDump(sql);
    console.log(
      `Extracted public schema: ${extracted.pre.length + extracted.post.length} DDL statements, ${extracted.tables.length} data blocks`,
    );

    const { client, restoredRows } = await restoreIntoPglite(extracted);
    try {
      console.log(`Restored ${restoredRows} rows into the throwaway PGlite.`);
      let pass = true;
      for (const table of CORE_TABLES) {
        const { rows } = await client.query(`select count(*)::int as n from public.${table}`);
        const count = rows[0].n;
        const ok = count > 0;
        pass &&= ok;
        console.log(`  ${ok ? "✓" : "✗"} ${table}: ${count} row${count === 1 ? "" : "s"}`);
      }
      if (pass) console.log("PASS — the backup artifact restores and the core tables hold data.");
      else fail("Some core tables are EMPTY in the restored backup.");
      process.exitCode = pass ? 0 : 1;
    } finally {
      await client.close();
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  console.log(MANUAL_STEPS);
  process.exitCode = 1;
});
