import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthMethodIds,
  ConnectorGrantOutputValues,
  DeviceAuthGrantConnectorType,
} from "../connectors";

export interface ConnectorAuthProviderGrantUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

export interface ConnectorAuthProviderGrantResultBase {
  readonly outputs: Readonly<Record<string, string | null | undefined>>;
  readonly expiresIn?: number;
  readonly scopes: readonly string[];
  readonly userInfo: ConnectorAuthProviderGrantUserInfo;
  readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
}

export interface ConnectorAuthProviderGrantResult<
  T extends AuthCodeGrantConnectorType | DeviceAuthGrantConnectorType,
  Method extends ConnectorAuthMethodIds<T>,
> extends ConnectorAuthProviderGrantResultBase {
  readonly outputs: ConnectorGrantOutputValues<T, Method>;
}
