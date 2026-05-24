import type { ConnectorType } from "../connectors";
import type { ConnectorAuthProvider } from "./provider-types";

export type ConnectorAuthSecretMetadata =
  | {
      readonly accessSecretName: string;
      readonly isRefreshable: false;
    }
  | {
      readonly accessSecretName: string;
      readonly refreshSecretName: string;
      readonly isRefreshable: true;
    };

export function getConnectorAuthSecretMetadata<T extends ConnectorType>(
  provider: ConnectorAuthProvider<T>,
): ConnectorAuthSecretMetadata {
  const access = provider.access;

  switch (access.kind) {
    case "none":
      return {
        accessSecretName: access.getAccessSecretName(),
        isRefreshable: false,
      };

    case "refresh-token":
      return {
        accessSecretName: access.getAccessSecretName(),
        refreshSecretName: access.getRefreshSecretName(),
        isRefreshable: true,
      };
  }
}
