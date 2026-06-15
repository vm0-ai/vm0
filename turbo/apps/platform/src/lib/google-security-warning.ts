import type { ConnectorType } from "@vm0/connectors/connectors";
import { isGoogleOAuthConnector } from "@vm0/connectors/auth-providers/oauth/google-connectors";

export function shouldShowGoogleSecurityWarningNotice(
  type: ConnectorType,
): boolean {
  return isGoogleOAuthConnector(type);
}

export function shouldShowMetaAdsReviewNotice(type: ConnectorType): boolean {
  return type === "meta-ads";
}

export function shouldShowConnectorConnectNotice(type: ConnectorType): boolean {
  return (
    shouldShowGoogleSecurityWarningNotice(type) ||
    shouldShowMetaAdsReviewNotice(type)
  );
}
