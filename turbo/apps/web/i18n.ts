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
  // Fallback to default locale if undefined
  const resolvedLocale = locale || defaultLocale;

  return {
    locale: resolvedLocale,
    messages: (await import(`./messages/${resolvedLocale}.json`)).default,
  };
});
