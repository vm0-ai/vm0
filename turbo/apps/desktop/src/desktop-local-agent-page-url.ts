const DESKTOP_LOCAL_AGENT_PATHS = new Set(["/local-agents", "/local-agents/"]);

export function isDesktopLocalAgentPageUrl(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      allowedAppOrigins.has(url.origin) &&
      DESKTOP_LOCAL_AGENT_PATHS.has(url.pathname)
    );
  } catch {
    return false;
  }
}
