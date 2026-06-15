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

export default getRequestConfig(async ({ requestLocale }) => {
  // In next-intl v4 the middleware-resolved locale arrives via requestLocale.
  // It can be undefined for pages outside the [locale] segment (e.g. root
  // layout, legal pages) or when an invalid URL reaches the config.
  const requested = await requestLocale;
  const resolvedLocale =
    requested && locales.includes(requested as Locale)
      ? (requested as Locale)
      : defaultLocale;

  return {
    locale: resolvedLocale,
    messages: (await import(`./messages/${resolvedLocale}.json`)).default,
  };
});
