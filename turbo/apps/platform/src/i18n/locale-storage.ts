import { DEFAULT_LOCALE, type SupportedLocale } from "./resources.ts";

const LOCALE_STORAGE_KEY_PREFIX = "vm0:locale:";

export function localeStorageKey(orgId: string): string {
  return `${LOCALE_STORAGE_KEY_PREFIX}${orgId}`;
}

function parseSupportedLocale(
  value: string | null | undefined,
): SupportedLocale | null {
  return value === "en-US" ||
    value === "pt-BR" ||
    value === "ja-JP" ||
    value === "ko-KR"
    ? value
    : null;
}

export function resolveDocumentLocale(): SupportedLocale {
  return parseSupportedLocale(document.documentElement.lang) ?? DEFAULT_LOCALE;
}
