import type { ConnectorType } from "@vm0/connectors/connectors";

export function shouldShowGoogleSecurityWarningNotice(
  type: ConnectorType,
): boolean {
  switch (type) {
    case "gmail":
    case "google-ads":
    case "google-calendar":
    case "google-docs":
    case "google-drive":
    case "google-meet":
    case "google-sheets": {
      return true;
    }
    default: {
      return false;
    }
  }
}
