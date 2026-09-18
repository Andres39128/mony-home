import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/features/auth/session";
import { logoutAction } from "@/features/auth/actions";
import TourLauncher from "@/features/tour/tour-launcher";
import { ThemeToggle } from "@/components/theme-toggle";

const ROLE_LABELS = { admin: "Administrador", member: "Miembro" } as const;

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/movimientos", label: "Movimientos" },
  { href: "/presupuesto", label: "Presupuesto" },
  { href: "/asistente", label: "Asistente" },
  { href: "/integrantes", label: "Integrantes" },
  { href: "/categorias", label: "Categorías" },
  { href: "/bolsas", label: "Bolsas" },
  { href: "/ahorro", label: "Ahorro" },
  { href: "/grupos", label: "Grupos" },
] as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-full flex-col bg-base font-sans">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="inline-flex min-h-11 items-center px-1 font-medium text-ink hover:underline"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <TourLauncher />
            <span className="text-muted">
              {user.name} · {ROLE_LABELS[user.role]}
            </span>
            <ThemeToggle />
            <form action={logoutAction}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium text-muted transition-colors hover:bg-base"
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
