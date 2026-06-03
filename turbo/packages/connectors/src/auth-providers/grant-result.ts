import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthMethodIds,
  ConnectorAuthMethodIdsByGrantKind,
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
  /** Seconds until the granted credentials expire. */
  readonly expiresIn?: number;
  readonly scopes: readonly string[];
  readonly userInfo: ConnectorAuthProviderGrantUserInfo;
  readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
}

type ConnectorAuthProviderGrantMethodId<
  T extends AuthCodeGrantConnectorType | DeviceAuthGrantConnectorType,
> = ConnectorAuthMethodIdsByGrantKind<T, "auth-code" | "device-auth">;

export type ConnectorAuthProviderGrantResultForMethod<
  T extends AuthCodeGrantConnectorType | DeviceAuthGrantConnectorType,
  Method extends ConnectorAuthMethodIds<T>,
> = [Method] extends [ConnectorAuthProviderGrantMethodId<T>]
  ? ConnectorAuthProviderGrantResult<ConnectorGrantOutputValues<T, Method>>
  : never;
