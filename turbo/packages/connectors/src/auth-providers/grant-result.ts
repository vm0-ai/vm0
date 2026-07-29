import type {
  ConnectorAuthProviderAuthMethodId,
  ConnectorAuthProviderConnectorSlug,
  ConnectorAuthProviderGrantOutputValuesFor,
} from "./provider-capabilities";

export interface ConnectorAuthProviderGrantUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

export type ConnectorAuthProviderGrantOutputValues = Readonly<
  Record<string, string | null | undefined>
>;

export interface ConnectorAuthProviderGrantResult<
  Outputs extends ConnectorAuthProviderGrantOutputValues =
    ConnectorAuthProviderGrantOutputValues,
> {
  readonly outputs: Outputs;
  /** Seconds until the granted credentials expire. */
  readonly expiresIn?: number;
  readonly scopes: readonly string[];
  readonly userInfo: ConnectorAuthProviderGrantUserInfo;
  readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
}

export type ConnectorAuthProviderGrantResultForMethod<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = ConnectorAuthProviderGrantResult<
  ConnectorAuthProviderGrantOutputValuesFor<ConnectorSlug, AuthMethodId>
>;
