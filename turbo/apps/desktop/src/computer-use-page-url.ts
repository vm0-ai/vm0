const DESKTOP_COMPUTER_USE_PATHS = new Set(["/computer-use", "/computer-use/"]);

export function isDesktopComputerUsePageUrl(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      allowedAppOrigins.has(url.origin) &&
      DESKTOP_COMPUTER_USE_PATHS.has(url.pathname)
    );
  } catch {
    return false;
  }
}
