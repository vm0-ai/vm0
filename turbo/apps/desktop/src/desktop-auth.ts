export const DESKTOP_AUTH_PROTOCOL = "vm0";

const DESKTOP_AUTH_HOST = "auth";
const DESKTOP_AUTH_CALLBACK_PATH = "/callback";
const DESKTOP_AUTH_CONSUME_PATH = "/desktop-auth/consume";
const DESKTOP_AUTH_START_WEB_PATH = "/desktop-auth/start";
const DESKTOP_AUTH_START_PATHS = new Set([
  "/desktop-auth/start",
  "/sign-in",
  "/sign-up",
]);
const DESKTOP_AUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

interface DesktopAuthCallback {
  readonly code: string;
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function parseDesktopAuthCallback(
  rawUrl: string,
): DesktopAuthCallback | null {
  const url = parseUrl(rawUrl);
  if (!url) {
    return null;
  }

  const code = url.searchParams.get("code");
  if (
    url.protocol !== `${DESKTOP_AUTH_PROTOCOL}:` ||
    url.hostname !== DESKTOP_AUTH_HOST ||
    url.pathname !== DESKTOP_AUTH_CALLBACK_PATH ||
    !code ||
    !DESKTOP_AUTH_CODE_PATTERN.test(code)
  ) {
    return null;
  }

  return { code };
}

export function buildDesktopAuthConsumeUrl(
  platformUrl: URL,
  code: string,
): string {
  const consumeUrl = new URL(DESKTOP_AUTH_CONSUME_PATH, platformUrl);
  consumeUrl.searchParams.set("code", code);
  return consumeUrl.toString();
}

export function buildDesktopAuthStartUrl(platformUrl: URL): string {
  return new URL(DESKTOP_AUTH_START_WEB_PATH, platformUrl).toString();
}

export function isDesktopAuthStartNavigation(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const url = parseUrl(rawUrl);
  return Boolean(
    url &&
    allowedAppOrigins.has(url.origin) &&
    DESKTOP_AUTH_START_PATHS.has(url.pathname),
  );
}
