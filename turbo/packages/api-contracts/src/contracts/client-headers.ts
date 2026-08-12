export const CLIENT_VERSION_HEADER = "X-Client-Version";
export const CLIENT_TYPE_HEADER = "X-Client-Type";
export const CLIENT_PRODUCT_HEADER = "X-Client-Product";
export const CLIENT_SESSION_ID_HEADER = "X-Client-Session-Id";
export const CLIENT_REQUEST_ID_HEADER = "X-Client-Request-Id";
export const CLIENT_FORCE_UPGRADE_STATUS = 426;

// Temporary App reader capability carried as SemVer build metadata on
// X-Client-Version. This avoids introducing a new CORS header while stale App
// bundles still need feedback locations projected out of persisted documents.
// Remove after the App rollout has exceeded the ~2-day stale-client window.
export const CLIENT_FEEDBACK_LOCATION_VERSION_TAG = "feedback-location-v1";

export function clientVersionWithTag(version: string, tag: string): string {
  return version.includes("+") ? `${version}.${tag}` : `${version}+${tag}`;
}

export function clientVersionHasTag(
  version: string | null | undefined,
  tag: string,
): boolean {
  const buildMetadata = version?.split("+", 2)[1];
  return buildMetadata?.split(".").includes(tag) ?? false;
}

// Canonical X-Client-Type wire values emitted by first-party clients.
export const CLIENT_TYPE_APP = "App";
export const CLIENT_TYPE_CLI = "CLI";
export const CLIENT_TYPE_DESKTOP = "Desktop";
export const CLIENT_TYPE_GUEST_AGENT = "GuestAgent";
export const CLIENT_TYPE_MITM_ADDON = "MitmAddon";
export const CLIENT_TYPE_RUNNER = "Runner";

export const DESKTOP_PRODUCT_ZERO = "zero";
export const DESKTOP_PRODUCT_OKOU = "okou";
export const DESKTOP_PRODUCTS = [
  DESKTOP_PRODUCT_ZERO,
  DESKTOP_PRODUCT_OKOU,
] as const;
export type DesktopProduct = (typeof DESKTOP_PRODUCTS)[number];

export function desktopProductFromClientHeader(
  value: string | null | undefined,
): DesktopProduct {
  return value === DESKTOP_PRODUCT_OKOU
    ? DESKTOP_PRODUCT_OKOU
    : DESKTOP_PRODUCT_ZERO;
}

export const CLIENT_HEADER_NAMES = [
  CLIENT_VERSION_HEADER,
  CLIENT_TYPE_HEADER,
  CLIENT_PRODUCT_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
] as const;
