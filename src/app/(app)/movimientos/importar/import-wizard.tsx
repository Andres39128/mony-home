"use client";

import { useActionState, useState, type ChangeEvent } from "react";
import type { ImportState } from "@/features/transactions/actions";
import type { ImportRowStatus } from "@/features/transactions/import";
import { Card } from "@/components/card";
import { FieldError, FormError, SubmitButton, Toggle, inputClass } from "@/components/forms";
import { formatCents } from "@/lib/money";

interface Props {
  action: (state: ImportState, formData: FormData) => Promise<ImportState>;
  categories: { id: string; name: string; kind: "income" | "expense"; isActive: boolean }[];
  members: { id: string; name: string; isActive: boolean }[];
  /** Default integrante: the acting admin. */
  currentMemberId: string;
  maxBytes: number;
}

const STEPS = ["Pegar o subir", "Mapear columnas", "Previsualizar e importar"] as const;

/** Estado chip copy for the preview table (duplicates stay out by default). */
function StatusChip({ row }: { row: { status: ImportRowStatus; motivo?: string } }) {
  if (row.status === "nuevo") {
    return (
      <span className="rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-on-accent">
        Nuevo
      </span>
    );
  }
  if (row.status === "duplicado") {
    return (
      <span className="rounded-full bg-honey px-2 py-0.5 text-xs font-medium text-on-accent">
        Duplicado ({row.motivo ?? "ya existe"})
      </span>
    );
  }
  return (
    <span className="rounded-full bg-danger-fill px-2 py-0.5 text-xs font-medium text-on-accent">
      Error — {row.motivo}
    </span>
  );
}

/**
 * Three-step CSV wizard (pegar/subir → mapear → previsualizar/importar).
 * The raw text lives ONLY in client state (a form field): the server never
 * round-trips it back. Mapping and globals are controlled so the final
 * import step can re-emit them as hidden fields.
 */
export default function ImportWizard({
  action,
  categories,
  members,
  currentMemberId,
  maxBytes,
}: Props) {
  const [state, formAction, pending] = useActionState(handleAction, {});
  // Wizard view override: "Volver"/"Importar otro" render earlier steps from
  // client state; any action result clears it.
  const [override, setOverride] = useState<1 | 2 | null>(null);
  const [raw, setRaw] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  // Mapping + globals (controlled so step 3 can re-submit them hidden).
  const [dateIndex, setDateIndex] = useState(0);
  const [amountIndex, setAmountIndex] = useState(1);
  const [noteIndex, setNoteIndex] = useState<string>("");
  const [type, setType] = useState<"income" | "expense">("expense");
  const [scope, setScope] = useState<"individual" | "common">("common");
  const [categoryId, setCategoryId] = useState("");
  const [memberId, setMemberId] = useState(currentMemberId);

  const step = override ?? state.step ?? 1;
  const parsed = state.parsed;

  async function handleAction(prev: ImportState, formData: FormData): Promise<ImportState> {
    setOverride(null);
    const result = await action(prev, formData);
    if (result.step === 2 && result.parsed) {
      // Fresh file → fresh guesses; the user refines from here.
      const guess = result.parsed.guess;
      setDateIndex(guess.date ?? 0);
      setAmountIndex(guess.amount ?? 0);
      setNoteIndex(guess.note === null ? "" : String(guess.note));
      setCategoryId(categories.find((category) => category.kind === "expense")?.id ?? "");
    }
    return result;
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    setFileError(null);
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > maxBytes) {
      setFileError("El archivo supera el máximo de 2 MB.");
      return;
    }
    setRaw(await file.text());
  }

  function reset() {
    setRaw("");
    setFileError(null);
    setOverride(1);
  }

  const header = parsed?.header ?? [];
  const columnOptions = header.map((name, index) => (
    <option key={index} value={index}>
      {index + 1}: {name.trim() !== "" ? name.trim() : "(sin nombre)"}
    </option>
  ));
  const matchingCategories = categories.filter((category) => category.kind === type);

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-wrap gap-2 text-sm">
        {STEPS.map((label, index) => {
          const number = index + 1;
          const current = number === step;
          return (
            <li
              key={label}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 ${
                current ? "border-ink bg-ink text-base font-medium" : "border-line bg-surface text-muted"
              }`}
            >
              <span className="tabular-nums">{number}.</span> {label}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <Card className="flex flex-col gap-4 p-6">
          <p className="text-sm text-muted">
            Pegá el contenido del CSV (hasta 2 MB) o subí el archivo. La primera
            fila debe ser el encabezado y una sola importación admite un único
            tipo de movimiento: para mezclar ingresos y gastos, importá dos veces.
          </p>
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="step" value="parse" />
            <textarea
              name="csv"
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              rows={10}
              required
              placeholder={"fecha,monto,nota\n2026-09-01,1500,supermercado"}
              className={`${inputClass} font-mono text-xs`}
              aria-label="Contenido del CSV"
            />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">O subí un archivo .csv</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                className="text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
              />
            </label>
            <FieldError message={fileError ?? undefined} />
            <FormError state={state} />
            <SubmitButton pending={pending}>Analizar archivo</SubmitButton>
          </form>
        </Card>
      )}

      {step === 2 && parsed && (
        <Card className="flex flex-col gap-4 p-6">
          <p className="text-sm text-muted">
            Delimitador detectado:{" "}
            <span className="font-medium text-ink">
              {parsed.delimiter === "\t" ? "tabulación" : `"${parsed.delimiter}"`}
            </span>
            . Confirmá qué columna es cada campo.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  {header.map((name, index) => (
                    <th key={index} scope="col" className="whitespace-nowrap px-2 py-2 font-medium">
                      {name.trim() !== "" ? name.trim() : `Columna ${index + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.sample.map((cells, rowIndex) => (
                  <tr key={rowIndex} className="border-b border-line last:border-b-0">
                    {header.map((_, cellIndex) => (
                      <td key={cellIndex} className="whitespace-nowrap px-2 py-1.5 text-ink">
                        {cells[cellIndex] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="step" value="preview" />
            <input type="hidden" name="csv" value={raw} />
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-muted">Columna de fecha</span>
                <select
                  name="dateIndex"
                  value={dateIndex}
                  onChange={(event) => setDateIndex(Number(event.target.value))}
                  className={inputClass}
                >
                  {columnOptions}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-muted">Columna de monto</span>
                <select
                  name="amountIndex"
                  value={amountIndex}
                  onChange={(event) => setAmountIndex(Number(event.target.value))}
                  className={inputClass}
                >
                  {columnOptions}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-muted">Columna de nota (opcional)</span>
                <select
                  name="noteIndex"
                  value={noteIndex}
                  onChange={(event) => setNoteIndex(event.target.value)}
                  className={inputClass}
                >
                  <option value="">— sin nota —</option>
                  {columnOptions}
                </select>
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-muted">Tipo (para todas las filas)</span>
                <Toggle
                  name="type"
                  value={type}
                  onChange={(value) => {
                    const next = value === "income" ? "income" : "expense";
                    setType(next);
                    // The category list is kind-scoped: keep the selection
                    // valid when the type flips (a controlled select's
                    // remount alone does NOT update state).
                    setCategoryId(
                      categories.find((category) => category.kind === next)?.id ?? "",
                    );
                  }}
                  options={[
                    { value: "expense", label: "Gasto" },
                    { value: "income", label: "Ingreso" },
                  ]}
                />
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-muted">
                  Categoría (para todas las filas)
                </span>
                {/* key={type} remounts on tipo change so the default always matches. */}
                <select
                  key={type}
                  name="categoryId"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  className={inputClass}
                >
                  {matchingCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                      {category.isActive ? "" : " (inactiva)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-muted">Integrante</span>
                <select
                  name="memberId"
                  value={memberId}
                  onChange={(event) => setMemberId(event.target.value)}
                  className={inputClass}
                >
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                      {member.isActive ? "" : " (inactivo)"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-muted">Ámbito</span>
                <Toggle
                  name="scope"
                  value={scope}
                  onChange={(value) => setScope(value === "individual" ? "individual" : "common")}
                  options={[
                    { value: "common", label: "Común" },
                    { value: "individual", label: "Individual" },
                  ]}
                />
              </div>
            </div>
            <p className="text-xs text-muted">
              Los montos van en valor absoluto (sin signo): el tipo elegido se
              aplica a todas las filas y un monto negativo se reporta como error.
            </p>
            <FormError state={state} />
            <div className="flex items-center gap-2">
              <SubmitButton pending={pending}>Ver previsualización</SubmitButton>
              <button
                type="button"
                onClick={() => setOverride(1)}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-base"
              >
                Volver
              </button>
            </div>
          </form>
        </Card>
      )}

      {/* Step 3 renders for BOTH outcomes: the preview form (preview set,
          no summary yet) and the post-commit confirmation (summary set —
          the action returns step 3 WITHOUT preview, so gating on preview
          alone made the summary unreachable). */}
      {step === 3 && (state.preview || state.summary) && (
        <Card className="flex flex-col gap-4 p-6">
        {/* Preview form: only when the classification is present and the
            commit has not run yet. */}
          {!state.summary && state.preview && (
            <>
              <p className="text-sm text-muted">
                Los duplicados quedan excluidos salvo que marques la casilla; las
                filas con error nunca se importan.
              </p>
              <form action={formAction} className="flex flex-col gap-4">
                <input type="hidden" name="step" value="import" />
                <input type="hidden" name="csv" value={raw} />
                <input type="hidden" name="dateIndex" value={dateIndex} />
                <input type="hidden" name="amountIndex" value={amountIndex} />
                <input type="hidden" name="noteIndex" value={noteIndex} />
                <input type="hidden" name="type" value={type} />
                <input type="hidden" name="scope" value={scope} />
                <input type="hidden" name="categoryId" value={categoryId} />
                <input type="hidden" name="memberId" value={memberId} />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                        <th scope="col" className="px-2 py-2 font-medium">Fecha</th>
                        <th scope="col" className="px-2 py-2 font-medium">Monto</th>
                        <th scope="col" className="px-2 py-2 font-medium">Nota</th>
                        <th scope="col" className="px-2 py-2 font-medium">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.preview.rows.map((row) => (
                        <tr key={row.line} className="border-b border-line last:border-b-0">
                          <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-ink">{row.date ?? "—"}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-ink">
                            {row.amountCents !== null ? formatCents(row.amountCents) : "—"}
                          </td>
                          <td className="max-w-64 truncate px-2 py-1.5 text-ink">{row.note ?? ""}</td>
                          <td className="px-2 py-1.5">
                            <StatusChip row={row} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="checkbox" name="includeDuplicates" value="1" className="size-4" />
                  Incluir duplicados ({state.preview.duplicados})
                </label>
                <FormError state={state} />
                <div className="flex items-center gap-2">
                  <SubmitButton pending={pending}>
                    Importar {state.preview.nuevos} nuevos
                  </SubmitButton>
                  <button
                    type="button"
                    onClick={() => setOverride(2)}
                    className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-base"
                  >
                    Volver
                  </button>
                </div>
              </form>
            </>
          )}
          {state.summary && (
            <div className="flex flex-col items-start gap-3">
              <p role="status" className="rounded-lg bg-sage px-3 py-2 text-sm text-on-accent">
                {state.summary}
              </p>
              <button
                type="button"
                onClick={reset}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-muted transition-colors hover:bg-base"
              >
                Importar otro archivo
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
