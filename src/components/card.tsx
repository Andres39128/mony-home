import type { ComponentPropsWithoutRef } from "react";

/**
 * Shared card surface: warm pastel background, hairline border, soft shadow.
 * Extra props (data-tour, aria, onClick...) pass through to the <article>.
 */
export function Card({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"article">) {
  return (
    <article
      className={`rounded-2xl border border-line bg-surface shadow-sm ${className ?? ""}`}
      {...rest}
    >
      {children}
    </article>
  );
}
