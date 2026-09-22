/**
 * The ONLY sanctioned money path (R2). Money is ALWAYS integer cents.
 *
 * `parseAmountToCents` accepts Argentine/Latin-local free-text amounts:
 * - '1500', '1500.75', '1500,75', '1.500,75', '1,234.56', '$ 1.500,75'
 * - Currency symbols and whitespace are stripped before parsing.
 * - When BOTH '.' and ',' appear, the LAST one is the decimal separator and
 *   the other one groups thousands.
 * - When only ONE separator type appears and the trailing group has exactly
 *   3 digits, it is a thousands separator (es-AR convention: '1.234' = 1234);
 *   any other trailing length is decimals ('1500,75' = 1500.75).
 * - EXCEPT when that single separator is a '.' with no other groups
 *   ('1.234', '12.345'): the es-AR thousands reading (1234) and a
 *   dot-as-decimal typo for '1.23' collide, so AmbiguousAmountError is
 *   thrown. Comma inputs ('2,285' = 2285) and multi-dot groups
 *   ('1.234.567' = 1234567) keep the thousands reading — neither admits a
 *   decimal reading.
 * - More than two decimal digits round half-up to the nearest cent
 *   ('1.2345' → 123 cents).
 * - Negative inputs ('-1500,75') parse to negative cents; positivity of
 *   expenses is enforced by the schema CHECK, not here.
 */

export class MoneyParseError extends Error {
  readonly input: string;

  constructor(input: string, reason: string) {
    super(`Cannot parse amount "${input}": ${reason}`);
    this.name = "MoneyParseError";
    this.input = input;
  }
}

/** A single-dot '1.234' input: thousands (1234) or dot-decimal typo for 1.23? */
export class AmbiguousAmountError extends MoneyParseError {
  constructor(input: string) {
    super(input, "ambiguous amount — write 1234 or 1.234,00 for thousands, or 1,23 for decimals");
    this.name = "AmbiguousAmountError";
  }
}

/** Validate thousands-style groups: none empty, first 1-3 digits, the rest exactly 3. */
function validateGroups(groups: string[], input: string): void {
  for (const [i, group] of groups.entries()) {
    if (group.length === 0) throw new MoneyParseError(input, "misplaced separator");
    if (i > 0 && group.length !== 3) {
      throw new MoneyParseError(input, `invalid digit grouping "${group}"`);
    }
    if (i === 0 && groups.length > 1 && group.length > 3) {
      throw new MoneyParseError(input, `invalid digit grouping "${group}"`);
    }
  }
}

export function parseAmountToCents(input: string): number {
  // Strip currency symbols and every kind of whitespace (incl. nbsp).
  const cleaned = input.replace(/[\s\u00A0$]/gu, "");
  if (cleaned.length === 0) throw new MoneyParseError(input, "no amount found");

  let negative = false;
  let body = cleaned;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }
  if (body.length === 0) throw new MoneyParseError(input, "no digits found");
  if (!/^[0-9.,]+$/.test(body)) throw new MoneyParseError(input, "contains invalid characters");

  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");

  let intPart: string;
  let decPart: string;

  if (lastDot === -1 && lastComma === -1) {
    intPart = body;
    decPart = "";
  } else {
    const decSep = lastDot > lastComma ? "." : ",";
    const thouSep = decSep === "." ? "," : ".";
    const splitAt = Math.max(lastDot, lastComma);
    const intRaw = body.slice(0, splitAt);
    decPart = body.slice(splitAt + 1);

    if (decPart.length === 0) {
      throw new MoneyParseError(input, "trailing separator with no decimals");
    }

    if (!body.includes(thouSep)) {
      // Only one separator type present.
      const groups = intRaw.split(decSep);
      if (decPart.length === 3) {
        // Trailing 3-digit group → es-AR thousands: '1.234' = 1234. With a
        // single dot and no comma the decimal reading ('1.23' + stray digit)
        // collides, so that one shape is rejected instead of guessed.
        if (decSep === "." && groups.length === 1) {
          throw new AmbiguousAmountError(input);
        }
        validateGroups(groups, input);
        intPart = groups.join("") + decPart;
        decPart = "";
      } else {
        // Decimal: separator occurrences before the last one are thousands groups.
        validateGroups(groups, input);
        intPart = groups.join("");
      }
    } else {
      // Both types present: the chosen decimal separator may appear only once,
      // and the other separator groups thousands.
      if (intRaw.includes(decSep)) {
        throw new MoneyParseError(input, "misplaced separator");
      }
      const groups = intRaw.split(thouSep);
      validateGroups(groups, input);
      intPart = groups.join("");
    }
  }

  // Integer-first arithmetic: never multiply a float by 100.
  const intCents = Number(intPart) * 100;
  let decCents = 0;
  if (decPart.length > 0) {
    const whole = decPart.slice(0, 2).padEnd(2, "0");
    const frac = decPart.slice(2);
    decCents = Number(whole) + (frac ? Math.round(Number(frac) / 10 ** frac.length) : 0);
  }

  const cents = intCents + decCents;
  if (!Number.isSafeInteger(cents)) throw new MoneyParseError(input, "amount is too large");
  return negative ? -cents : cents;
}

export function centsToNumber(cents: number): number {
  return cents / 100;
}

export function formatCents(cents: number, currency = "ARS"): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency }).format(
    centsToNumber(cents),
  );
}

/**
 * Compact abbreviation for chart axes only (never for real amounts):
 * 1_540_000 cents → '15,4 k'. Exact values always go through formatCents.
 */
export function formatCentsCompact(cents: number): string {
  return new Intl.NumberFormat("es-AR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(centsToNumber(cents));
}

/** Percentage of `part` over `total`, rounded to 2 decimals; 0 when total <= 0. */
export function percentage(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}
