import { getRequestConfig } from "next-intl/server";

// Supported locales
export const locales = ["en", "de", "ja", "es"] as const;
export type Locale = (typeof locales)[number];

// Default locale
export const defaultLocale: Locale = "en";

// Language names for the language switcher
export const languageNames: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  ja: "日本語",
  es: "Español",
};

export default getRequestConfig(async ({ locale }) => {
  // Validate locale and fallback to default if invalid
  // This prevents errors from malformed URLs like /favicon.ico/blog
  const resolvedLocale =
    locale && locales.includes(locale as Locale) ? locale : defaultLocale;

  return {
    locale: resolvedLocale,
    messages: (await import(`./messages/${resolvedLocale}.json`)).default,
  };
});
