/**
 * Minimal RFC 4180 CSV reader — hand-rolled on purpose (the export side
 * lives in features/transactions/csv.ts with its quoting guard; adding a
 * parser dependency for one wizard is bloat).
 *
 * Supports: quoted fields, embedded delimiters/newlines/quotes (""),
 * CRLF and LF line endings, UTF-8 BOM tolerance (the export route emits one,
 * so re-importing an export must not poison the first header cell).
 * Lenient by design: a quote appearing mid-field is kept literally.
 */
export type CsvDelimiter = "," | ";" | "\t";

const CANDIDATES = [",", ";", "\t"] as const;

function stripBom(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

/** Delimiter of the first non-empty line, by frequency; ties → comma (RFC 4180 default). */
export function detectDelimiter(input: string): CsvDelimiter {
  const firstLine = stripBom(input).split("\n", 1)[0] ?? "";
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Parses the whole input into rows of string cells (no trimming — callers own that). */
export function parseCsv(input: string, delimiter: CsvDelimiter): string[][] {
  const text = stripBom(input).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index++;
        continue;
      }
      field += char;
      index++;
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
      index++;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      index++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index++;
      continue;
    }
    field += char;
    index++;
  }

  // Last field/row when the input does not end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
