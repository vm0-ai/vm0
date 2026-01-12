// @vm0/i18n - Shared internationalization package
// Translation files and utilities for web and platform apps

export const locales = ["en", "de", "ja", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const languageNames: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  ja: "日本語",
  es: "Español",
};

// Re-export message loading utilities
export async function loadMessages(
  locale: Locale,
): Promise<Record<string, unknown>> {
  const messages = await import(`../messages/${locale}.json`);
  return messages.default as Record<string, unknown>;
}
