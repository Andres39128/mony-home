"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import {
  SESSION_COOKIE_NAME,
  createSession,
  destroySession,
  ipFromHeaders,
  loginWithIpGuard,
} from "@/lib/auth";
import { clearSessionCookie, setSessionCookie } from "@/features/auth/session";

/**
 * UI-facing state for the login form (consumed via useActionState).
 * `error` is a translation key by convention; messages render in Spanish.
 */
export interface LoginState {
  error?: "invalid_credentials" | "locked" | "inactive" | "rate_limited";
}

const loginInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

export async function loginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginInputSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
  });
  // Invalid shape is treated as bad credentials — no information leaks.
  if (!parsed.success) return { error: "invalid_credentials" };

  // Client IP from the edge proxy (Vercel: first x-forwarded-for value);
  // unknown IPs share one conservative bucket inside the guard.
  const ip = ipFromHeaders(await headers());
  const result = await loginWithIpGuard(getDb(), ip, parsed.data.username, parsed.data.password);
  if (!result.ok) return { error: result.error };

  const { token, expiresAt } = await createSession(getDb(), result.user.id);
  await setSessionCookie(token, expiresAt);
  // redirect() throws NEXT_REDIRECT by design — keep it outside try/catch.
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (token) await destroySession(getDb(), token);
  await clearSessionCookie();
  redirect("/login");
}
