const VERCEL_PROTECTION_BYPASS_NAME = "x-vercel-protection-bypass";

const PREVIEW_BYPASS_COOKIE_MAX_AGE_SECONDS = 60 * 60;
const PREVIEW_COOKIE_ROOT_DOMAIN = "vm6.ai";

interface PreviewBypassCookieLocation {
  readonly hostname: string;
  readonly protocol: string;
  readonly search: string;
}

function previewCookieDomain(hostname: string): string | undefined {
  const normalized = hostname.toLowerCase();
  return normalized === PREVIEW_COOKIE_ROOT_DOMAIN ||
    normalized.endsWith(`.${PREVIEW_COOKIE_ROOT_DOMAIN}`)
    ? `.${PREVIEW_COOKIE_ROOT_DOMAIN}`
    : undefined;
}

export function buildPreviewBypassCookie(
  location: PreviewBypassCookieLocation,
): string | null {
  const bypass = new URLSearchParams(location.search).get(
    VERCEL_PROTECTION_BYPASS_NAME,
  );
  if (!bypass) {
    return null;
  }

  const segments = [
    `${VERCEL_PROTECTION_BYPASS_NAME}=${encodeURIComponent(bypass)}`,
    "Path=/",
    `Max-Age=${PREVIEW_BYPASS_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  const domain = previewCookieDomain(location.hostname);
  if (domain) {
    segments.push(`Domain=${domain}`);
  }
  if (location.protocol === "https:") {
    segments.push("Secure");
  }
  return segments.join("; ");
}

export function writePreviewBypassCookie(
  location: PreviewBypassCookieLocation,
  setCookie: (cookie: string) => void,
): boolean {
  const cookie = buildPreviewBypassCookie(location);
  if (!cookie) {
    return false;
  }
  setCookie(cookie);
  return true;
}

export function capturePreviewBypassCookieFromLocation(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  writePreviewBypassCookie(window.location, (cookie) => {
    // oxlint-disable-next-line unicorn/no-document-cookie -- must synchronously set the shared preview cookie before the first API request.
    document.cookie = cookie;
  });
}
