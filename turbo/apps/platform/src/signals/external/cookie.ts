import { command, computed, state } from "ccstate";

const COOKIE_NAME_PREFIX = "__Secure-okou-";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const cookieReload$ = state(0);

type UnprefixedCookieKey<Key extends string> =
  Key extends `${typeof COOKIE_NAME_PREFIX}${string}` ? never : Key;

function readCookieValue(name: string): string | null {
  /* eslint-disable ccstate/no-catch-abort -- synchronous DOM access cannot carry an application AbortSignal. */
  // eslint-disable-next-line no-restricted-syntax -- browser privacy policies can block cookie access.
  try {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(";")) {
      const cookie = part.trim();
      if (cookie.startsWith(prefix)) {
        return decodeURIComponent(cookie.slice(prefix.length));
      }
    }
    return null;
  } catch {
    return null;
  }
  /* eslint-enable ccstate/no-catch-abort */
}

function sharedCookieDomain(hostname: string): string | null {
  const normalizedHostname = hostname.toLowerCase();
  for (const domain of ["okou.ai", "omby.ai", "vm0.ai"] as const) {
    if (
      normalizedHostname === domain ||
      normalizedHostname.endsWith(`.${domain}`)
    ) {
      return `.${domain}`;
    }
  }
  return null;
}

function expireHostOnlyCookie(name: string): void {
  // oxlint-disable-next-line unicorn/no-document-cookie -- domain promotion must remove a same-name host-only cookie first.
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

function writeCookieValue(name: string, value: string): void {
  const domain = sharedCookieDomain(window.location.hostname);
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  const serialized = `${name}=${encodeURIComponent(value)}${domainAttribute}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;

  /* eslint-disable ccstate/no-catch-abort -- synchronous DOM access cannot carry an application AbortSignal. */
  // eslint-disable-next-line no-restricted-syntax -- blocked cookie writes must not prevent the in-memory preference from applying.
  try {
    if (domain && window.location.hostname.toLowerCase() !== domain.slice(1)) {
      expireHostOnlyCookie(name);
    }
    // oxlint-disable-next-line unicorn/no-document-cookie -- theme persistence must be synchronous across sibling subdomains.
    document.cookie = serialized;
  } catch {
    // The caller's in-memory state remains valid for this page load.
  }
  /* eslint-enable ccstate/no-catch-abort */
}

export const refreshCookies$ = command(({ set }) => {
  set(cookieReload$, (previous) => {
    return previous + 1;
  });
});

export function cookieSignals<const Key extends string>(
  key: UnprefixedCookieKey<Key>,
) {
  const name = `${COOKIE_NAME_PREFIX}${key}`;

  const get$ = computed((get) => {
    get(cookieReload$);
    return readCookieValue(name);
  });

  const set$ = command(({ set }, value: string) => {
    writeCookieValue(name, value);
    set(refreshCookies$);
  });

  const promoteToSharedDomain$ = command(({ set }): string | null => {
    const domain = sharedCookieDomain(window.location.hostname);
    if (!domain || window.location.hostname.toLowerCase() === domain.slice(1)) {
      return readCookieValue(name);
    }

    const hostValue = readCookieValue(name);
    /* eslint-disable ccstate/no-catch-abort -- synchronous DOM access cannot carry an application AbortSignal. */
    // eslint-disable-next-line no-restricted-syntax -- promotion must preserve a parent-domain cookie while removing an older host-only duplicate.
    try {
      expireHostOnlyCookie(name);
    } catch {
      return hostValue;
    }
    /* eslint-enable ccstate/no-catch-abort */

    const sharedValue = readCookieValue(name);
    const value = sharedValue ?? hostValue;
    if (sharedValue === null && value !== null) {
      writeCookieValue(name, value);
    }
    set(refreshCookies$);
    return value;
  });

  return Object.freeze({ get$, promoteToSharedDomain$, set$ });
}
