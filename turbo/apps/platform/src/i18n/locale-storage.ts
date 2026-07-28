import { DEFAULT_LOCALE, type SupportedLocale } from "./resources.ts";

const LOCALE_STORAGE_KEY_PREFIX = "vm0:locale:";

export function localeStorageKey(orgId: string): string {
  return `${LOCALE_STORAGE_KEY_PREFIX}${orgId}`;
}

function parseSupportedLocale(
  value: string | null | undefined,
): SupportedLocale | null {
  return value === "en-US" || value === "zh-CN" ? value : null;
}

export function resolveBrowserLocale(
  language: string = navigator.language,
): SupportedLocale {
  return /^zh(?:-|$)/iu.test(language) ? "zh-CN" : DEFAULT_LOCALE;
}

export function resolveDocumentLocale(): SupportedLocale {
  return parseSupportedLocale(document.documentElement.lang) ?? DEFAULT_LOCALE;
}
