import type { ThemePreference } from "@okouai/api-contracts/contracts/user-preferences";
import { isOkouHostname } from "./platform-host.ts";

const OKOU_THEME_COOKIE_NAME = "__Secure-okou-theme";
const OKOU_THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const OKOU_THEME_COOKIE_VERSION = "v1";

function decodeOkouThemePreference(
  value: string | null,
): ThemePreference | null {
  if (!value?.startsWith(`${OKOU_THEME_COOKIE_VERSION}.`)) {
    return null;
  }

  const preference = value.slice(OKOU_THEME_COOKIE_VERSION.length + 1);
  return preference === "light" ||
    preference === "dark" ||
    preference === "system"
    ? preference
    : null;
}

function encodeOkouThemePreference(preference: ThemePreference): string {
  return `${OKOU_THEME_COOKIE_VERSION}.${preference}`;
}

function readOkouThemePreferenceCookie(
  cookieHeader: string,
): ThemePreference | null {
  const prefix = `${OKOU_THEME_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) {
      const preference = decodeOkouThemePreference(cookie.slice(prefix.length));
      if (preference) {
        return preference;
      }
    }
  }
  return null;
}

function resolveOkouThemeCookieDomain(
  hostname: string,
): ".okou.ai" | ".omby.ai" | null {
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizedHostname === "okou.ai" ||
    normalizedHostname.endsWith(".okou.ai")
  ) {
    return ".okou.ai";
  }
  if (
    normalizedHostname === "omby.ai" ||
    normalizedHostname.endsWith(".omby.ai")
  ) {
    return ".omby.ai";
  }
  return null;
}

function serializeOkouThemePreferenceCookie(
  preference: ThemePreference,
  hostname: string,
): string | null {
  if (!isOkouHostname(hostname)) {
    return null;
  }

  const domain = resolveOkouThemeCookieDomain(hostname);
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  return `${OKOU_THEME_COOKIE_NAME}=${encodeOkouThemePreference(preference)}${domainAttribute}; Path=/; Max-Age=${OKOU_THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}

export function readOkouThemePreferenceFromDocument(): ThemePreference | null {
  /* eslint-disable ccstate/no-catch-abort -- synchronous DOM access cannot carry an application AbortSignal. */
  // eslint-disable-next-line no-restricted-syntax -- cookie access may throw under browser privacy policies, and theme bootstrap must fall back safely.
  try {
    return readOkouThemePreferenceCookie(document.cookie);
  } catch {
    return null;
  }
  /* eslint-enable ccstate/no-catch-abort */
}

export function writeOkouThemePreferenceToDocument(
  preference: ThemePreference,
): void {
  const cookie = serializeOkouThemePreferenceCookie(
    preference,
    window.location.hostname,
  );
  if (!cookie) {
    return;
  }

  /* eslint-disable ccstate/no-catch-abort -- synchronous DOM access cannot carry an application AbortSignal. */
  // eslint-disable-next-line no-restricted-syntax -- synchronous cookie persistence may be blocked and must not break theme application.
  try {
    // oxlint-disable-next-line unicorn/no-document-cookie -- first-paint continuity requires a synchronous cross-subdomain preference write.
    document.cookie = cookie;
  } catch {
    // Cookie access can be blocked. Theme still applies for this page load.
  }
  /* eslint-enable ccstate/no-catch-abort */
}
