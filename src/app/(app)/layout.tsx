import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/features/auth/session";
import { logoutAction } from "@/features/auth/actions";

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

/** Routes landing in later phases — rendered as inert text, not dead links. */
const UPCOMING_LINKS = ["Presupuesto"] as const;

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/movimientos", label: "Movimientos" },
  { href: "/integrantes", label: "Integrantes" },
  { href: "/categorias", label: "Categorías" },
  { href: "/bolsas", label: "Bolsas" },
  { href: "/grupos", label: "Grupos" },
] as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-full flex-col bg-zinc-50 font-sans dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav className="flex items-center gap-4 text-sm">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
              >
                {link.label}
              </Link>
            ))}
            {UPCOMING_LINKS.map((label) => (
              <span key={label} className="text-zinc-400 dark:text-zinc-600">
                {label}
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {user.name} · {ROLE_LABELS[user.role]}
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cerrar sesión
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
