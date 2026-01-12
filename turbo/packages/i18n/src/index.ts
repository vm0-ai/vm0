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

// Message loading utility (uses switch for bundler compatibility)
export async function loadMessages(
  locale: Locale,
): Promise<Record<string, unknown>> {
  switch (locale) {
    case "en":
      return (await import("../messages/en.json")).default as Record<
        string,
        unknown
      >;
    case "de":
      return (await import("../messages/de.json")).default as Record<
        string,
        unknown
      >;
    case "ja":
      return (await import("../messages/ja.json")).default as Record<
        string,
        unknown
      >;
    case "es":
      return (await import("../messages/es.json")).default as Record<
        string,
        unknown
      >;
    default:
      return (await import("../messages/en.json")).default as Record<
        string,
        unknown
      >;
  }
}
