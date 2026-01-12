import { getRequestConfig } from "next-intl/server";
import { locales, defaultLocale, type Locale } from "@vm0/i18n";

// Re-export from @vm0/i18n for backward compatibility
export { locales, defaultLocale, languageNames, type Locale } from "@vm0/i18n";

async function getMessages(locale: Locale) {
  switch (locale) {
    case "en":
      return (await import("@vm0/i18n/messages/en.json")).default;
    case "de":
      return (await import("@vm0/i18n/messages/de.json")).default;
    case "ja":
      return (await import("@vm0/i18n/messages/ja.json")).default;
    case "es":
      return (await import("@vm0/i18n/messages/es.json")).default;
    default:
      return (await import("@vm0/i18n/messages/en.json")).default;
  }
}

export default getRequestConfig(async ({ locale }) => {
  // Fallback to default locale if undefined
  const resolvedLocale = (locale || defaultLocale) as Locale;

  return {
    locale: resolvedLocale,
    messages: await getMessages(resolvedLocale),
  };
});
