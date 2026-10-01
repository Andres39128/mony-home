"use client";

import { setDefaultCurrency } from "@/lib/money";

interface Props {
  currencyCode: string;
  locale: string;
}

/**
 * Client half of the currency bootstrap. Several panels (bolsas, préstamos,
 * presupuesto, recurrentes) format cents at hydration through the shared
 * money module; this component assigns the configured currency/locale
 * synchronously during render, BEFORE any sibling client component renders,
 * so SSR output and client hydration always agree (no mismatch, no flash of
 * the fallback currency). Renders nothing.
 */
export default function CurrencyBoot({ currencyCode, locale }: Props) {
  setDefaultCurrency(currencyCode, locale);
  return null;
}
