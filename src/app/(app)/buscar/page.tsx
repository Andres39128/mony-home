import Link from "next/link";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import {
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
  globalSearch,
  normalizeQuery,
} from "@/features/search/service";
import { asLocalDate, dateFormatter } from "@/lib/date";
import { formatCents } from "@/lib/money";
import { singleParam } from "@/lib/page-params";
import { Card } from "@/components/card";
import { inputClass } from "@/components/forms";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/** Same labels the préstamos panel uses (client-local there, mirrored here). */
const LOAN_KIND_LABELS = {
  credit_card: "Tarjeta",
  investment_line: "Libre inversión",
  mortgage: "Hipoteca",
  other: "Otro",
} as const;

const GOAL_KIND_LABELS = { savings: "Ahorro", investment: "Inversión" } as const;

/** Colored money chips: the movements-page palette, reused verbatim. */
const CHIP_INCOME = "rounded-lg bg-sage px-2 py-0.5 text-on-accent";
const CHIP_EXPENSE = "rounded-lg bg-danger-fill px-2 py-0.5 text-on-accent";

export default async function BuscarPage({ searchParams }: { searchParams: SearchParams }) {
  await requireUser();
  const params = await searchParams;
  const q = normalizeQuery(singleParam(params, "q") ?? "");
  const results = await globalSearch(getDb(), q);
  const tooShort = q.length > 0 && q.length < SEARCH_MIN_QUERY_LENGTH;
  // The movements screen filters by note only (its existing q filter) — the
  // honest follow-up link for the movement hits found here.
  const movementsHref = `/movimientos?q=${encodeURIComponent(q)}`;

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Buscar</h1>

      {/* Shareable, no-JS GET form: the query lives in the URL (?q=). */}
      <search>
        <form action="/buscar" method="get" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            maxLength={SEARCH_MAX_QUERY_LENGTH}
            placeholder="Movimientos, bolsas y préstamos…"
            aria-label="Buscar en todo el hogar"
            className={inputClass}
          />
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 py-2 text-sm font-medium text-base transition-colors hover:bg-ink/90"
          >
            Buscar
          </button>
        </form>
      </search>

      {tooShort && (
        <p className="text-sm text-muted">Escribí al menos {SEARCH_MIN_QUERY_LENGTH} caracteres.</p>
      )}

      {!tooShort && q.length > 0 && (
        <>
          <Card className="p-5">
            <h2 className="text-sm font-medium text-muted">Movimientos</h2>
            {results.movements.length === 0 ? (
              <p className="mt-3 text-sm text-muted">Sin resultados en movimientos.</p>
            ) : (
              <>
                <ul className="mt-3 flex flex-col divide-y divide-line">
                  {results.movements.map((movement) => (
                    <li key={movement.id} className="flex items-baseline justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">
                          {movement.categoryName ?? "Sin categoría"}
                          <span className="font-normal text-muted"> · {movement.memberName}</span>
                        </p>
                        <p className="text-xs tabular-nums text-muted">
                          {dateFormatter.format(asLocalDate(movement.date))}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 text-sm font-semibold tabular-nums ${
                          movement.type === "income" ? CHIP_INCOME : CHIP_EXPENSE
                        }`}
                      >
                        {formatCents(movement.amountCents)}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={movementsHref}
                  className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
                >
                  Ver en movimientos
                </Link>
              </>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-medium text-muted">Bolsas</h2>
            {results.bolsas.length === 0 ? (
              <p className="mt-3 text-sm text-muted">Sin resultados en bolsas.</p>
            ) : (
              <ul className="mt-3 flex flex-col divide-y divide-line">
                {results.bolsas.map((goal) => (
                  <li key={goal.id}>
                    <Link
                      href="/bolsas"
                      className="flex items-baseline justify-between gap-3 py-2 transition-colors hover:bg-base"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">
                          {goal.name}
                        </span>
                        <span className="text-xs text-muted">
                          {GOAL_KIND_LABELS[goal.kind]}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                        {formatCents(goal.netCents)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-medium text-muted">Préstamos</h2>
            {results.prestamos.length === 0 ? (
              <p className="mt-3 text-sm text-muted">Sin resultados en préstamos.</p>
            ) : (
              <ul className="mt-3 flex flex-col divide-y divide-line">
                {results.prestamos.map((loan) => (
                  <li key={loan.id}>
                    <Link
                      href="/prestamos"
                      className="flex items-baseline justify-between gap-3 py-2 transition-colors hover:bg-base"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">
                          {loan.name}
                        </span>
                        <span className="text-xs text-muted">
                          {LOAN_KIND_LABELS[loan.kind]} · {loan.entity}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-danger-text">
                        {formatCents(loan.outstandingCents)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {q.length === 0 && (
        <p className="text-sm text-muted">
          Buscá entre tus movimientos, bolsas y préstamos del hogar.
        </p>
      )}
    </section>
  );
}
