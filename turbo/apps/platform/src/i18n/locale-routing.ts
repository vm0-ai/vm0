import { isOkouHostname } from "../lib/platform-host.ts";
import { SUPPORTED_LOCALES, type SupportedLocale } from "./resources.ts";

const LOCALE_PATH_PREFIX_BY_LOCALE = {
  "en-US": "en",
  "pt-BR": "pt-BR",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "id-ID": "id",
  "de-DE": "de",
  "es-ES": "es",
  "it-IT": "it",
  "fr-FR": "fr",
  "hi-IN": "hi",
} as const satisfies Record<SupportedLocale, string>;

export interface LocaleRoute {
  readonly locale: SupportedLocale | null;
  readonly pathname: string;
}

export function localePathPrefix(locale: SupportedLocale): string {
  return LOCALE_PATH_PREFIX_BY_LOCALE[locale];
}

function localeForPathPrefix(prefix: string): SupportedLocale | null {
  for (const locale of SUPPORTED_LOCALES) {
    if (localePathPrefix(locale) === prefix) {
      return locale;
    }
  }
  return null;
}

/**
 * Resolves an explicit Okou locale prefix and returns the logical app route.
 * VM0 routes and unsupported prefixes are intentionally left unchanged.
 */
export function resolveLocaleRoute(
  pathname: string,
  hostname: string,
): LocaleRoute {
  if (!isOkouHostname(hostname)) {
    return { locale: null, pathname };
  }

  const [prefix = "", ...suffixSegments] = pathname.slice(1).split("/");
  const locale = localeForPathPrefix(prefix);
  if (!locale) {
    return { locale: null, pathname };
  }

  const suffix = suffixSegments.join("/");
  return {
    locale,
    pathname: suffix ? `/${suffix}` : "/",
  };
}

export function localePrefixedPathname(
  pathname: string,
  locale: SupportedLocale,
): string {
  const prefix = localePathPrefix(locale);
  return pathname === "/" ? `/${prefix}` : `/${prefix}${pathname}`;
}

export function replaceLocalePathPrefix(
  pathname: string,
  hostname: string,
  locale: SupportedLocale,
): string {
  if (!isOkouHostname(hostname)) {
    return pathname;
  }
  return localePrefixedPathname(
    resolveLocaleRoute(pathname, hostname).pathname,
    locale,
  );
}

export function preserveLocalePathPrefix(
  pathname: string,
  hostname: string,
  locale: SupportedLocale | null,
): string {
  if (!locale || !isOkouHostname(hostname)) {
    return pathname;
  }
  return localePrefixedPathname(pathname, locale);
}
