import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { listMembers } from "@/features/members/service";
import {
  AUDIT_ENTITIES,
  AUDIT_ENTITY_LABELS,
  listAudits,
  type AuditFilters,
} from "@/features/audit/service";
import { dateTimeFormatter } from "@/lib/date";
import { hrefWith, singleParam } from "@/lib/page-params";
import { inputClass } from "@/components/forms";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/** Rows per page on the audit trail (its own cadence: 50 dense rows). */
const AUDIT_PAGE_SIZE = 50;

/** Colored chips: entity + action badges stay legible on both themes. */
const ENTITY_CLASS =
  "w-fit rounded-lg bg-mint px-2 py-0.5 text-xs font-medium text-on-accent";
const ACTION_CLASS =
  "w-fit rounded-lg bg-honey px-2 py-0.5 text-xs font-medium text-on-accent";

/**
 * Admin-only audit trail (F9). UI hiding is never trusted: the page bounces
 * non-admins server-side, same as the import wizard.
 */
export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");

  const params = await searchParams;
  // Lenient GET filters (trust boundary): unknown values just match nothing.
  const rawEntity = singleParam(params, "entity");
  const filters: AuditFilters = {
    entity: AUDIT_ENTITIES.find((entity) => entity === rawEntity),
    actorId: singleParam(params, "actorId"),
  };
  const page = Math.max(1, Number.parseInt(singleParam(params, "page") ?? "1", 10) || 1);

  const [result, members] = await Promise.all([
    listAudits(getDb(), filters, page, AUDIT_PAGE_SIZE),
    listMembers(getDb()),
  ]);
  const { rows, total, page: safePage } = result;

  const firstRow = (safePage - 1) * AUDIT_PAGE_SIZE + 1;
  const lastRow = (safePage - 1) * AUDIT_PAGE_SIZE + rows.length;
  const pageParams = { entity: filters.entity ?? null, actorId: filters.actorId ?? null };
  const prevHref = safePage > 1 ? hrefWith("/auditoria", params, { ...pageParams, page: String(safePage - 1) }) : null;
  const nextHref =
    lastRow < total ? hrefWith("/auditoria", params, { ...pageParams, page: String(safePage + 1) }) : null;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Auditoría</h1>
        <p className="text-sm text-muted">
          Registro de cambios del hogar: quién hizo qué y cuándo. Las entradas
          no se pueden editar ni borrar desde la app.
        </p>
      </div>

      {/* Shareable, no-JS filters: one GET form for entity + actor. */}
      <form action="/auditoria" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Entidad</span>
          <select name="entity" defaultValue={filters.entity ?? ""} className={inputClass}>
            <option value="">Todas</option>
            {AUDIT_ENTITIES.map((entity) => (
              <option key={entity} value={entity}>
                {AUDIT_ENTITY_LABELS[entity]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Integrante</span>
          <select name="actorId" defaultValue={filters.actorId ?? ""} className={inputClass}>
            <option value="">Todos</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-base"
        >
          Filtrar
        </button>
        {(filters.entity || filters.actorId) && (
          <a
            href="/auditoria"
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-base"
          >
            Limpiar
          </a>
        )}
      </form>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
          Todavía no hay registros{filters.entity || filters.actorId ? " con ese filtro" : ""}.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-line bg-surface px-5 py-3 text-sm shadow-sm"
            >
              <span className="w-28 shrink-0 text-xs tabular-nums text-muted">
                {dateTimeFormatter.format(row.createdAt)}
              </span>
              <span className="font-medium text-ink">{row.actorName}</span>
              <span className={ENTITY_CLASS}>
                {AUDIT_ENTITY_LABELS[row.entity as keyof typeof AUDIT_ENTITY_LABELS] ?? row.entity}
              </span>
              <span className={ACTION_CLASS}>{row.action}</span>
              <span className="min-w-0 flex-1 text-muted">{row.summary ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}

      {total > 0 && (
        <nav
          aria-label="Paginación de auditoría"
          className="flex items-center justify-between gap-3 text-sm text-muted"
        >
          <span aria-live="polite">
            {firstRow}–{lastRow} de {total}
          </span>
          <div className="flex gap-2">
            {prevHref ? (
              <a
                href={prevHref}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium transition-colors hover:bg-base"
              >
                Anterior
              </a>
            ) : (
              <span
                aria-disabled
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium opacity-40"
              >
                Anterior
              </span>
            )}
            {nextHref ? (
              <a
                href={nextHref}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium transition-colors hover:bg-base"
              >
                Siguiente
              </a>
            ) : (
              <span
                aria-disabled
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-medium opacity-40"
              >
                Siguiente
              </span>
            )}
          </div>
        </nav>
      )}
    </section>
  );
}
