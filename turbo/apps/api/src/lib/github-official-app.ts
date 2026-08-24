import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

export const OFFICIAL_GITHUB_PUBLIC_BRAND = "okou" satisfies PublicBrand;

function normalizedProviderValue(
  value: string | null | undefined,
): string | undefined {
  return value?.trim() || undefined;
}

export function githubAppBotUsername(appSlug: string): string {
  return `@${appSlug}[bot]`;
}

export function githubAppUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}`;
}

export function resolveGithubAppIdentity(args: {
  readonly configuredAppId: string | undefined;
  readonly configuredAppSlug: string | undefined;
  readonly installationAppId: string | null;
  readonly installationAppSlug: string | null;
}): {
  readonly appId: string | undefined;
  readonly appSlug: string | undefined;
} {
  const configuredAppId = normalizedProviderValue(args.configuredAppId);
  const configuredAppSlug = normalizedProviderValue(args.configuredAppSlug);
  const installationAppId = normalizedProviderValue(args.installationAppId);
  const installationAppSlug = normalizedProviderValue(args.installationAppSlug);
  const isOfficialInstallation =
    installationAppId === undefined || installationAppId === configuredAppId;

  return {
    appId: installationAppId ?? configuredAppId,
    appSlug: isOfficialInstallation
      ? (configuredAppSlug ?? installationAppSlug)
      : installationAppSlug,
  };
}
