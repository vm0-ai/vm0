import type { ConnectorAuthCodeGrantConfig } from "../../../connector-config";

export function authCodeGrantFixture(
  scopes: readonly string[],
  callbackOrigin?: ConnectorAuthCodeGrantConfig["callbackOrigin"],
): ConnectorAuthCodeGrantConfig {
  return {
    kind: "auth-code",
    scopes: [...scopes],
    ...(callbackOrigin === undefined ? {} : { callbackOrigin }),
    outputs: {
      accessToken: "$secrets.TEST_ACCESS_TOKEN",
      refreshToken: "$secrets.TEST_REFRESH_TOKEN",
    },
  };
}
