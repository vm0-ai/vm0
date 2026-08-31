import type { BrowserContext } from "@playwright/test";

export const VERCEL_PROTECTION_BYPASS_NAME = "x-vercel-protection-bypass";

type BrowserContextCookie = Parameters<BrowserContext["addCookies"]>[0][number];
type CookieContext = Pick<BrowserContext, "addCookies">;

export function previewBypassCookie(
  appUrl: string,
  bypassSecret: string,
): BrowserContextCookie {
  const appOrigin = new URL(appUrl);
  return {
    name: VERCEL_PROTECTION_BYPASS_NAME,
    value: encodeURIComponent(bypassSecret),
    url: appOrigin.origin,
    sameSite: "Lax",
    secure: appOrigin.protocol === "https:",
  };
}

export async function installPreviewBypassCookie(
  context: CookieContext,
  appUrl: string,
  bypassSecret: string,
): Promise<void> {
  await context.addCookies([previewBypassCookie(appUrl, bypassSecret)]);
}
