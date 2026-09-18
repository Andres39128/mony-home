import { getConfig } from "@/lib/config";
import { loginAction } from "@/features/auth/actions";
import { ThemeToggle } from "@/components/theme-toggle";
import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <main className="relative flex flex-1 items-center justify-center bg-base px-4 font-sans">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight text-ink">
          {getConfig().APP_NAME}
        </h1>
        <LoginForm action={loginAction} />
      </div>
    </main>
  );
}
