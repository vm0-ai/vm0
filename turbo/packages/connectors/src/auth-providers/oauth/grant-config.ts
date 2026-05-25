import type {
  ConnectorAuthCodeGrantConfig,
  ConnectorDeviceAuthGrantConfig,
  OAuthAuthCodeConnectorType,
  OAuthDeviceAuthConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthCodeGrantConfigIfSupported,
  getConnectorDeviceAuthGrantConfigIfSupported,
} from "@vm0/connectors/connector-utils";

export function getAuthCodeGrantConfig(
  type: OAuthAuthCodeConnectorType,
): ConnectorAuthCodeGrantConfig {
  const grant = getConnectorAuthCodeGrantConfigIfSupported(type);
  if (!grant) {
    throw new Error(`${type} auth-code grant config not found`);
  }
  return { ...grant, scopes: [...grant.scopes] };
}

export function getDeviceAuthGrantConfig(
  type: OAuthDeviceAuthConnectorType,
): ConnectorDeviceAuthGrantConfig {
  const grant = getConnectorDeviceAuthGrantConfigIfSupported(type);
  if (!grant) {
    throw new Error(`${type} device-auth grant config not found`);
  }
  return { ...grant, scopes: [...grant.scopes] };
}
