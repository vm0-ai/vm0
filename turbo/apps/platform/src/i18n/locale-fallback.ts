import { isOkouHostname } from "../lib/platform-host.ts";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./resources.ts";

export const OKOU_LOCALE_COOKIE_NAME = "__Secure-okou-locale";

const OKOU_LOCALE_COOKIE_VERSION = "v1";

function decodeOkouLocale(value: string | null): SupportedLocale | null {
  if (!value?.startsWith(`${OKOU_LOCALE_COOKIE_VERSION}.`)) {
    return null;
  }

  const locale = value.slice(OKOU_LOCALE_COOKIE_VERSION.length + 1);
  return isSupportedLocale(locale) ? locale : null;
}

function readOkouLocaleCookie(cookieHeader: string): SupportedLocale | null {
  const prefix = `${OKOU_LOCALE_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) {
      const locale = decodeOkouLocale(cookie.slice(prefix.length));
      if (locale) {
        return locale;
      }
    }
  }
  return null;
}

function localeForBrowserLanguage(language: string): SupportedLocale | null {
  const primaryLanguage = language.trim().toLowerCase().split("-")[0];
  return (
    SUPPORTED_LOCALES.find((locale) => {
      return locale.toLowerCase().split("-")[0] === primaryLanguage;
    }) ?? null
  );
}

function resolveBrowserLocale(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const locale = localeForBrowserLanguage(language);
    if (locale) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

function resolveInitialLocaleFallback({
  hostname,
  cookieHeader,
  browserLanguages,
}: {
  readonly hostname: string;
  readonly cookieHeader: string;
  readonly browserLanguages: readonly string[];
}): SupportedLocale {
  // Site and browser values are initial hints for Okou only. Authenticated
  // workspace preference sync remains authoritative after bootstrap.
  if (!isOkouHostname(hostname)) {
    return DEFAULT_LOCALE;
  }

  return (
    readOkouLocaleCookie(cookieHeader) ?? resolveBrowserLocale(browserLanguages)
  );
}

export function resolveInitialLocaleFallbackFromBrowser(): SupportedLocale {
  const browserLanguages =
    navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return resolveInitialLocaleFallback({
    hostname: window.location.hostname,
    cookieHeader: document.cookie,
    browserLanguages,
  });
}
