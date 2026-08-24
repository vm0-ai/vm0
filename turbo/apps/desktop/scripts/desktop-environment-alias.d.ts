export type DesktopEnvironmentAliasKey =
  | "OKOU_DESKTOP_PLATFORM_URL"
  | "OKOU_DESKTOP_PRODUCT";

export function resolveDesktopEnvironmentAlias(
  canonicalKey: DesktopEnvironmentAliasKey,
): string | undefined;
