"use client";

import { useRef, useState, useTransition } from "react";
import { askAssistantAction } from "@/features/assistant/actions";
import {
  HISTORY_TURNS_SENT,
  QUESTION_MAX_LENGTH,
  type HistoryTurn,
} from "@/features/assistant/service";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

let messageId = 0;

function nextMessageId(): string {
  messageId += 1;
  return `m${messageId}`;
}

interface AssistantChatProps {
  /** Server-rendered quota snapshot at page load. */
  initialRemaining: number;
  limit: number;
}

/**
 * Neutral-Spanish copy per typed degradation error. Never a raw error dump:
 * unknown codes fall back to the generic retry line.
 */
const ERROR_COPY: Record<string, string> = {
  quota_exceeded: "Alcanzaste tu límite de hoy; vuelve mañana",
  rate_limited: "El servicio está saturado, probá en unos minutos",
  provider_down: "El asistente no respondió, reintentá",
  timeout: "El asistente no respondió, reintentá",
  auth_error: "Configuración del asistente incompleta (avisale al admin)",
  no_credits: "Configuración del asistente incompleta (avisale al admin)",
  invalid_question: "Escribí una pregunta.",
};

/** Wraps amount-like tokens ($ 1.234,56) in monospace so figures stand out. */
const AMOUNT_SPLIT_RE = /(\$[\d.,]*[\d]|\b\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?%?)/g;

function MessageText({ content }: { content: string }) {
  const parts = content.split(AMOUNT_SPLIT_RE);
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // Split-with-capture groups alternate plain/amount, so the index IS
          // the stable identity of each segment within this fixed content.
          <span key={index} className="font-mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/**
 * Assistant chat: history lives client-side (only the last HISTORY_TURNS_SENT
 * turns ride along on each request), send is disabled while pending, and the
 * quota indicator refreshes from every successful response.
 */
export default function AssistantChat({ initialRemaining, limit }: AssistantChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(initialRemaining);
  const listRef = useRef<HTMLDivElement>(null);

  function send() {
    const question = input.trim();
    if (question.length === 0 || pending) return;
    if (question.length > QUESTION_MAX_LENGTH) {
      setError(`La pregunta es demasiado larga (máximo ${QUESTION_MAX_LENGTH} caracteres).`);
      return;
    }

    // Snapshot BEFORE appending: the new question travels separately.
    const history: HistoryTurn[] = messages.slice(-HISTORY_TURNS_SENT);
    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { id: nextMessageId(), role: "user", content: question }]);

    startTransition(async () => {
      const result = await askAssistantAction(question, history);
      if (result.ok) {
        setMessages((prev) => [...prev, { id: nextMessageId(), role: "assistant", content: result.answer }]);
        setRemaining(result.remaining);
      } else {
        setError(ERROR_COPY[result.error] ?? "El asistente no respondió, reintentá");
      }
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
    });
  }

  const exhausted = remaining <= 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p
          role="status"
          data-tour="asistente-cuota"
          className="text-sm text-zinc-600 dark:text-zinc-400"
          aria-live="polite"
        >
          Te quedan <span className="font-mono font-semibold">{remaining}</span> de{" "}
          <span className="font-mono">{limit}</span> preguntas hoy
        </p>
        <p
          data-tour="asistente-limites"
          className="text-xs text-zinc-400 dark:text-zinc-500"
        >
          El asistente solo ve agregados del mes, nunca tus movimientos individuales.
        </p>
      </div>

      <div
        ref={listRef}
        className="flex max-h-[28rem] min-h-48 flex-col gap-3 overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
      >
        {messages.length === 0 && !pending && (
          <p className="mx-auto my-auto text-center text-sm text-zinc-500 dark:text-zinc-400">
            Preguntá por tus gastos, presupuestos o bolsas de este mes.
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`max-w-[85%] rounded-2xl px-4 py-2 ${
              message.role === "user"
                ? "self-end bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "self-start border border-zinc-200 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            }`}
          >
            <MessageText content={message.content} />
          </div>
        ))}
        {pending && (
          <p role="status" aria-live="polite" className="self-start px-4 py-2 text-sm text-zinc-500 dark:text-zinc-400">
            Pensando…
          </p>
        )}
        {error && (
          <p role="alert" className="self-start rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}
      </div>

      <form
        data-tour="asistente-input"
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={exhausted ? "Volvé mañana…" : "Escribí tu pregunta…"}
          maxLength={QUESTION_MAX_LENGTH}
          disabled={pending || exhausted}
          aria-label="Tu pregunta para el asistente"
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:border-zinc-100"
        />
        <button
          type="submit"
          disabled={pending || exhausted || input.trim().length === 0}
          className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
