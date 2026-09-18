/**
 * Recharts click handlers deliver the hovered shape, whose `payload` field
 * carries the original datum (typed `any` upstream — never imported here).
 * This guard extracts it without leaking `any` into app code.
 */
export function chartPayload(event: { payload?: unknown }): Record<string, unknown> | null {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : null;
}

/** Joins the active filter query string with one more param for drill-down. */
export function withQueryParam(query: string, key: string, value: string): string {
  const params = new URLSearchParams(query);
  params.set(key, value);
  return params.toString();
}
