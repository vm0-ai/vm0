import type { DesktopConfig } from "./config";

const DESKTOP_UPDATE_CHANNEL = "stable";
const DESKTOP_UPDATE_PLATFORM = "darwin";
const DESKTOP_UPDATE_ARCH = "arm64";

interface DesktopAutoUpdateEligibility {
  readonly environment: DesktopConfig["environment"];
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

export function shouldInstallDesktopAutoUpdates(
  eligibility: DesktopAutoUpdateEligibility,
): boolean {
  return (
    eligibility.environment === "production" &&
    eligibility.isPackaged &&
    eligibility.platform === DESKTOP_UPDATE_PLATFORM &&
    eligibility.arch === DESKTOP_UPDATE_ARCH
  );
}

export function desktopUpdateFeedBaseUrl(
  apiBaseUrl: string,
  updateLine: DesktopConfig["identity"]["updateLine"],
): string {
  const url = new URL(apiBaseUrl);
  // The `zero` line used to be spelled as the unqualified path, which predates
  // the `:product` routes. #31475 removed that route, so every line now names
  // itself in the path.
  url.pathname = `/api/desktop/updates/${encodeURIComponent(updateLine)}/${DESKTOP_UPDATE_CHANNEL}/${DESKTOP_UPDATE_PLATFORM}/${DESKTOP_UPDATE_ARCH}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
