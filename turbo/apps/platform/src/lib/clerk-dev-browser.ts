const CLERK_DEV_BROWSER_NAME = "__clerk_db_jwt";
const CLERK_DEV_BROWSER_SUFFIXED_PREFIX = `${CLERK_DEV_BROWSER_NAME}_`;

export const CLERK_DEV_BROWSER_ROTATION_HEADER = "Clerk-Db-Jwt";

export function isDevelopmentClerkInstance(publishableKey: string): boolean {
  return publishableKey.startsWith("pk_test_");
}

/**
 * Development Clerk instances authenticate a browser with a dev browser JWT
 * instead of a first-party cookie on the Frontend API domain. Clerk keeps it in
 * a document cookie, which a SharedWorker cannot read, so the page has to hand
 * it over.
 */
export function readClerkDevBrowserJwt(cookieHeader: string): string | null {
  let plain: string | null = null;
  for (const segment of cookieHeader.split(";")) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = segment.slice(0, separatorIndex).trim();
    const value = decodeURIComponent(segment.slice(separatorIndex + 1).trim());
    if (value.length === 0) {
      continue;
    }
    if (name.startsWith(CLERK_DEV_BROWSER_SUFFIXED_PREFIX)) {
      return value;
    }
    if (name === CLERK_DEV_BROWSER_NAME) {
      plain = value;
    }
  }
  return plain;
}

export function withClerkDevBrowserJwt(url: URL, jwt: string): URL {
  const next = new URL(url);
  next.searchParams.set(CLERK_DEV_BROWSER_NAME, jwt);
  return next;
}
