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

export type ConnectorAuthProviderGrantOutputValues = Readonly<
  Record<string, string | null | undefined>
>;

export interface ConnectorAuthProviderGrantResult<
  Outputs extends ConnectorAuthProviderGrantOutputValues =
    ConnectorAuthProviderGrantOutputValues,
> {
  readonly outputs: Outputs;
  readonly expiresIn?: number;
  readonly scopes: readonly string[];
  readonly userInfo: ConnectorAuthProviderGrantUserInfo;
  readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
}

export type ConnectorAuthProviderGrantResultForMethod<
  T extends AuthCodeGrantConnectorType | DeviceAuthGrantConnectorType,
  Method extends ConnectorAuthMethodIds<T>,
> = ConnectorAuthProviderGrantResult<ConnectorGrantOutputValues<T, Method>>;
