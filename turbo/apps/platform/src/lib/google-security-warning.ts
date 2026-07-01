import type { ConnectorType } from "@vm0/connectors/connectors";
import { isGoogleOAuthConnector } from "@vm0/connectors/auth-providers/oauth/google-connectors";

export function shouldShowGoogleSecurityWarningNotice(
  type: ConnectorType,
): boolean {
  return isGoogleOAuthConnector(type);
}
