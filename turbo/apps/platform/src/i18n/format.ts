import { i18n } from "./index.ts";
import { DEFAULT_LOCALE } from "./resources.ts";

export function resolvedAppLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE;
}

export function formatAppNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(resolvedAppLocale(), options).format(value);
}

export function formatLocalizedNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return formatAppNumber(value, options);
}

export function formatCompactNumber(
  value: number,
  maximumFractionDigits = 1,
): string {
  return formatLocalizedNumber(value, {
    notation: "compact",
    maximumFractionDigits,
  });
}

export function formatUsd(dollars: number, fractionDigits = 2): string {
  return formatLocalizedNumber(dollars, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
