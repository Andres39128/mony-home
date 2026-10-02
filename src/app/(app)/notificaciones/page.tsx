import Link from "next/link";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { deriveNotifications } from "@/features/notifications/service";
import { Card } from "@/components/card";

/**
 * Derived in-app notifications (F7). Household-wide (olla común): every
 * member sees the same list, nothing is per-user. The items are COMPUTED on
 * read (no stored state) — the same derivation the bell would need, so the
 * bell itself stays a plain link instead of paying this read-set on every
 * navigation.
 */
const SEVERITY_CHIP = {
  warn: "rounded-lg bg-danger-fill px-2 py-0.5 text-xs font-medium text-on-accent",
  info: "rounded-lg bg-line px-2 py-0.5 text-xs font-medium text-ink",
} as const;

const SEVERITY_LABEL = { warn: "Atención", info: "Info" } as const;

export default async function NotificacionesPage() {
  await requireUser();
  const items = await deriveNotifications(getDb());

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Notificaciones</h1>

      {items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">Todo tranquilo por ahora</Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm transition-colors hover:bg-base"
              >
                <span className={`mt-0.5 shrink-0 ${SEVERITY_CHIP[item.severity]}`}>
                  {SEVERITY_LABEL[item.severity]}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{item.title}</span>
                  {item.detail && (
                    <span className="mt-0.5 block text-xs tabular-nums text-muted">
                      {item.detail}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
