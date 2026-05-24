import type { ConnectorType } from "../connectors";
import type { ConnectorAuthProvider } from "./provider-types";

type AuthProviderSecretAccess =
  | {
      readonly kind: "none";
      getAccessSecretName(): string;
    }
  | {
      readonly kind: "refresh-token";
      getAccessSecretName(): string;
      getRefreshSecretName(): string;
    };

type AuthProviderWithSecretMetadata = {
  readonly access: AuthProviderSecretAccess;
};

export type AuthProviderSecretMetadata =
  | {
      readonly accessSecretName: string;
      readonly isRefreshable: false;
    }
  | {
      readonly accessSecretName: string;
      readonly refreshSecretName: string;
      readonly isRefreshable: true;
    };

export type ConnectorAuthSecretMetadata = AuthProviderSecretMetadata;

export function getAuthProviderSecretMetadata(
  provider: AuthProviderWithSecretMetadata,
): AuthProviderSecretMetadata {
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

export function getConnectorAuthSecretMetadata<T extends ConnectorType>(
  provider: ConnectorAuthProvider<T>,
): ConnectorAuthSecretMetadata {
  return getAuthProviderSecretMetadata(provider);
}
