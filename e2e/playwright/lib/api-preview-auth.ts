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
