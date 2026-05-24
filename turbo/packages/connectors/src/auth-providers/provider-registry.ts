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
