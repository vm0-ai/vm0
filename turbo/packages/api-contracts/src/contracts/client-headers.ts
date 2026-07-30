export const CLIENT_VERSION_HEADER = "X-Client-Version";
export const CLIENT_TYPE_HEADER = "X-Client-Type";
export const CLIENT_SESSION_ID_HEADER = "X-Client-Session-Id";
export const CLIENT_REQUEST_ID_HEADER = "X-Client-Request-Id";
export const CLIENT_CAPABILITY_PT_BR_LOCALE = "pt-br-locale-v1";
export const CLIENT_CAPABILITY_JA_JP_LOCALE = "ja-jp-locale-v1";
export const CLIENT_CAPABILITY_KO_KR_LOCALE = "ko-kr-locale-v1";
export const CLIENT_CAPABILITY_CONNECTOR_SLUG_IDENTITIES =
  "connector-slug-identities-v1";
export const ZERO_MAIL_CLIENT_VERSION_HEADER = "X-Zero-Mail-Client-Version";
export const ZERO_MAIL_CLIENT_VERSION = "3";
export const CLIENT_FORCE_UPGRADE_STATUS = 426;

// Canonical X-Client-Type wire values emitted by first-party clients.
export const CLIENT_TYPE_APP = "App";
export const CLIENT_TYPE_CLI = "CLI";
export const CLIENT_TYPE_DESKTOP = "Desktop";
export const CLIENT_TYPE_GUEST_AGENT = "GuestAgent";
export const CLIENT_TYPE_MITM_ADDON = "MitmAddon";
export const CLIENT_TYPE_RUNNER = "Runner";

/**
 * Advertise optional protocol capabilities without adding a new CORS header.
 * SemVer build metadata is ignored by older API version checks.
 */
export function addClientCapabilityToVersion(
  version: string,
  capability: string,
): string {
  const separator = version.includes("+") ? "." : "+";
  return `${version}${separator}${capability}`;
}

export function clientVersionSupportsCapability(
  version: string | null | undefined,
  capability: string,
): boolean {
  const buildMetadata = version?.split("+")[1];
  return buildMetadata?.split(".").includes(capability) ?? false;
}

export const CLIENT_HEADER_NAMES = [
  CLIENT_VERSION_HEADER,
  CLIENT_TYPE_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  ZERO_MAIL_CLIENT_VERSION_HEADER,
] as const;
