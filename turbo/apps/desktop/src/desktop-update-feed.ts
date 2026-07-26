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

export function desktopUpdateFeedBaseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.pathname = `/api/desktop/updates/${DESKTOP_UPDATE_CHANNEL}/${DESKTOP_UPDATE_PLATFORM}/${DESKTOP_UPDATE_ARCH}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
