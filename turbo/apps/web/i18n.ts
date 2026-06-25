import { getRequestConfig } from "next-intl/server";

// Supported locales
export const locales = ["en", "de", "ja", "es"] as const;
export type Locale = (typeof locales)[number];

// Default locale
export const defaultLocale: Locale = "en";

export default getRequestConfig(async ({ requestLocale }) => {
  // In next-intl v4 the middleware-resolved locale arrives via requestLocale.
  // It can be undefined for root utility pages or when an invalid URL reaches
  // the config.
  const requested = await requestLocale;
  const resolvedLocale =
    requested && locales.includes(requested as Locale)
      ? (requested as Locale)
      : defaultLocale;

  return {
    locale: resolvedLocale,
    messages: {},
  };
});
