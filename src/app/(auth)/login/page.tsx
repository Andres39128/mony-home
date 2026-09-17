import { getConfig } from "@/lib/config";
import { loginAction } from "@/features/auth/actions";
import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {getConfig().APP_NAME}
        </h1>
        <LoginForm action={loginAction} />
      </div>
    </main>
  );
}
