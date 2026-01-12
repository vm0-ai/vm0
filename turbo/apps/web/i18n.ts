import { getRequestConfig } from "next-intl/server";
import { locales, defaultLocale, type Locale } from "@vm0/i18n";

// Re-export from @vm0/i18n for backward compatibility
export { locales, defaultLocale, languageNames, type Locale } from "@vm0/i18n";

export default getRequestConfig(async ({ locale }) => {
  // Fallback to default locale if undefined
  const resolvedLocale = (locale || defaultLocale) as Locale;

  // Import from shared package
  const messages = await import(`@vm0/i18n/messages/${resolvedLocale}.json`);
  return {
    locale: resolvedLocale,
    messages: messages.default,
  };
});
