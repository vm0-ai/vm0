import { locales, defaultLocale, type Locale } from "../../../i18n";

const BASE_URL = "https://www.vm0.ai";

/**
 * Build hreflang alternates for a localized page.
 *
 * @param localeLessPath - Path WITHOUT the locale prefix (e.g. `/blog/posts/foo` or `/use-cases/sentry-triage`). Use `""` for the homepage.
 * @param currentLocale  - The locale of the page being rendered (used for the canonical URL).
 */
export function buildLocaleAlternates(
  localeLessPath: string,
  currentLocale: Locale,
) {
  const normalized = localeLessPath === "/" ? "" : localeLessPath;

  const languages: Record<string, string> = {};
  for (const loc of locales) {
    languages[loc] = `${BASE_URL}/${loc}${normalized}`;
  }
  languages["x-default"] = `${BASE_URL}/${defaultLocale}${normalized}`;

  return {
    canonical: `${BASE_URL}/${currentLocale}${normalized}`,
    languages,
  };
}
