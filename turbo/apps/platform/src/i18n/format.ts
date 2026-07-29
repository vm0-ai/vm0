import { currentLocale } from "./index.ts";

export function resolvedAppLocale(): string {
  return currentLocale();
}

export function formatLocalizedNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(resolvedAppLocale(), options).format(value);
}

export function formatAppNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return formatLocalizedNumber(value, options);
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
