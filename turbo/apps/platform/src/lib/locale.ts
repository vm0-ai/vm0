export const SUPPORTED_LOCALES = ["en", "de", "ja", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export async function detectLocale(
  user: any | null | undefined,
): Promise<Locale> {
  // Priority 1: Clerk metadata
  if (user?.publicMetadata?.locale) {
    const clerkLocale = user.publicMetadata.locale as string;
    if (SUPPORTED_LOCALES.includes(clerkLocale as Locale)) {
      return clerkLocale as Locale;
    }
  }

  // Priority 2: Browser language
  const browserLang = navigator.language.split("-")[0];
  if (SUPPORTED_LOCALES.includes(browserLang as Locale)) {
    return browserLang as Locale;
  }

  // Priority 3: Default
  return DEFAULT_LOCALE;
}

export async function loadMessages(
  locale: Locale,
): Promise<Record<string, string>> {
  // Import from web app's translation files
  const messages = await import(`../../../../web/messages/${locale}.json`);
  return messages.default;
}
