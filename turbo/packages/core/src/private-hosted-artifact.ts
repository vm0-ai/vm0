const PRIVATE_HOSTED_VIEW_PATH =
  /^\/api\/host\/private-deployments\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/view$/u;

/** Stable references carry no content credential. */
export function privateHostedDeploymentId(
  url: string,
  apiOrigin: string,
): string | null {
  if (!URL.canParse(url)) {
    return null;
  }
  const parsed = new URL(url);
  if (
    parsed.origin !== new URL(apiOrigin).origin ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  return PRIVATE_HOSTED_VIEW_PATH.exec(parsed.pathname)?.[1] ?? null;
}
