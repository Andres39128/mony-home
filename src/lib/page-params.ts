/**
 * Shared search-param plumbing for the (app) pages: single-value extraction
 * and "same URL, some params overridden/dropped" href building. Keeping the
 * URL shapes here means every filtered page produces identical link shapes.
 */
type Params = Record<string, string | string[] | undefined>;

/** The param's single string value, or undefined when absent/empty. */
export function singleParam(params: Params, key: string) {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** URL of basePath with the same params, overriding/dropping some. */
export function hrefWith(
  basePath: string,
  params: Params,
  overrides: Record<string, string | null>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key in overrides) continue;
    if (typeof value === "string" && value) query.set(key, value);
    else if (Array.isArray(value)) for (const item of value) if (item) query.append(key, item);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
