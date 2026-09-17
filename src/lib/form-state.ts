/**
 * Shared shape for server-action form state surfaced through useActionState.
 * `ok` renders a success notice, `error` a single friendly message, and
 * `fieldErrors` per-input validation messages keyed by input name.
 */
export interface FormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/** First issue per field, keyed by input name (zod issue paths). */
export function fieldErrorsFrom(
  issues: { path: (string | number | symbol)[]; message: string }[],
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}
