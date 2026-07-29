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
