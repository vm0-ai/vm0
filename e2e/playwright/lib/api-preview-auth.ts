import type { BrowserContext } from "@playwright/test";

export type ApiPreviewHeaders = Readonly<
  Partial<
    Record<
      | "x-vercel-protection-bypass"
      | "cf-access-client-id"
      | "cf-access-client-secret",
      string
    >
  >
>;

export function apiPreviewHeaders(): ApiPreviewHeaders {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error(
      "Cloudflare Access credentials must be configured together",
    );
  }
  return {
    ...(bypassSecret
      ? { "x-vercel-protection-bypass": bypassSecret }
      : undefined),
    ...(accessClientId && accessClientSecret
      ? {
          "cf-access-client-id": accessClientId,
          "cf-access-client-secret": accessClientSecret,
        }
      : undefined),
  };
}

export async function installApiPreviewHeadersForUrl(
  context: BrowserContext,
  apiUrl: string,
): Promise<void> {
  const previewHeaders = apiPreviewHeaders();
  if (Object.keys(previewHeaders).length === 0) {
    return;
  }
  if (previewHeaders["cf-access-client-id"]) {
    // A persisted browser state can carry a short-lived Access assertion.
    // Clear it so the service-token headers mint a fresh assertion instead.
    await context.clearCookies({ name: "CF_Authorization" });
  }
  const apiOrigin = new URL(apiUrl).origin;
  await context.route(`${apiOrigin}/**`, async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        ...previewHeaders,
      },
    });
  });
}
