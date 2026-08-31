import type { BrowserContext } from "@playwright/test";

const VERCEL_PROTECTION_BYPASS_COOKIE = "x-vercel-protection-bypass";

export async function seedPreviewBypassCookie(
  context: BrowserContext,
  appUrl: string,
  bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
): Promise<void> {
  if (!bypassSecret) {
    return;
  }

  const url = new URL(appUrl);
  await context.addCookies([
    {
      name: VERCEL_PROTECTION_BYPASS_COOKIE,
      sameSite: "Lax",
      secure: url.protocol === "https:",
      url: url.origin,
      value: bypassSecret,
    },
  ]);
}
