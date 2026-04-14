import { locales, defaultLocale, type Locale } from "../../../i18n";

const BASE_URL = "https://www.vm0.ai";

/**
 * Build hreflang alternates for a localized page.
 *
 * @param localeLessPath   - Path WITHOUT the locale prefix (e.g. `/blog/posts/foo` or `/use-cases/sentry-triage`). Use `""` for the homepage.
 * @param currentLocale    - The locale of the page being rendered (used for the canonical URL).
 * @param availableLocales - Optional subset of locales that actually have content.
 *                           When omitted every supported locale is emitted.
 *                           Pass this for CMS-driven pages (blog posts) where
 *                           some translations may not exist.
 */
export function buildLocaleAlternates(
  localeLessPath: string,
  currentLocale: Locale,
  availableLocales?: readonly Locale[],
) {
  const normalized = localeLessPath === "/" ? "" : localeLessPath;
  const emitLocales = availableLocales ?? locales;

  const languages: Record<string, string> = {};
  for (const loc of emitLocales) {
    languages[loc] = `${BASE_URL}/${loc}${normalized}`;
  }
  // x-default points to the default-locale version so search engines have a
  // clear fallback.  Using the prefixed /en/… path avoids the 307 redirect
  // that the locale-less path would trigger.
  languages["x-default"] = `${BASE_URL}/${defaultLocale}${normalized}`;

  return {
    canonical: `${BASE_URL}/${currentLocale}${normalized}`,
    languages,
  };
}
