import type {
  ConnectorAuthCodeGrantConfig,
  ConnectorDeviceAuthGrantConfig,
  AuthCodeGrantConnectorType,
  DeviceAuthGrantConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthCodeGrantConfig,
  getConnectorDeviceAuthGrantConfig,
} from "@vm0/connectors/connector-utils";

export function getAuthCodeGrantConfig(
  type: AuthCodeGrantConnectorType,
): ConnectorAuthCodeGrantConfig {
  const grant = getConnectorAuthCodeGrantConfig(type);
  return { ...grant, scopes: [...grant.scopes] };
}

export function getDeviceAuthGrantConfig(
  type: DeviceAuthGrantConnectorType,
): ConnectorDeviceAuthGrantConfig {
  const grant = getConnectorDeviceAuthGrantConfig(type);
  return { ...grant, scopes: [...grant.scopes] };
}
