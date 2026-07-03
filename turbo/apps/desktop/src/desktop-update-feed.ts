import type { DesktopConfig } from "./config";

const DESKTOP_UPDATE_CHANNEL = "stable";
const DESKTOP_UPDATE_PLATFORM = "darwin";

type DesktopUpdateArchitecture = "arm64" | "x64";

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
    desktopUpdateArchitecture(eligibility.arch) !== null
  );
}

export function desktopUpdateArchitecture(
  arch: NodeJS.Architecture,
): DesktopUpdateArchitecture | null {
  return arch === "arm64" || arch === "x64" ? arch : null;
}

export function desktopUpdateFeedBaseUrl(
  apiBaseUrl: string,
  arch: DesktopUpdateArchitecture,
): string {
  const url = new URL(apiBaseUrl);
  url.pathname = `/api/desktop/updates/${DESKTOP_UPDATE_CHANNEL}/${DESKTOP_UPDATE_PLATFORM}/${arch}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
