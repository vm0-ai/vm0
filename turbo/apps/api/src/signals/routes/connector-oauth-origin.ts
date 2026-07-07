import {
  connectorAuthCodeCallbacksUseOnlyApiOrigin,
  getConnectorAuthMethodAuthCodeCallbackOrigin,
  getConnectorAuthMethodOpenIdAuthCallbackOrigin,
} from "@vm0/connectors/connector-utils";
import type {
  AuthCodeGrantConnectorType,
  ConnectorBrowserAuthCallbackOrigin,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorOpenIdAuthGrantAuthMethodId,
  OpenIdAuthGrantConnectorType,
} from "@vm0/connectors/connectors";

import {
  getOAuthApiOrigin,
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "./oauth-web-origin";

export { getOAuthWebOrigin as getConnectorOAuthOrigin };

function resolveCallbackOrigin(
  request: Request,
  callbackOrigin: ConnectorBrowserAuthCallbackOrigin,
): string {
  switch (callbackOrigin) {
    case "api": {
      return getOAuthApiOrigin(request);
    }
    case "web": {
      return getOAuthWebOrigin(request);
    }
  }
}

export function getConnectorOAuthCallbackOrigin<
  Type extends AuthCodeGrantConnectorType,
>(args: {
  readonly request: Request;
  readonly type: Type;
  readonly authMethod: ConnectorAuthCodeGrantAuthMethodId<Type>;
}): string {
  const callbackOrigin = getConnectorAuthMethodAuthCodeCallbackOrigin(
    args.type,
    args.authMethod,
  );
  return resolveCallbackOrigin(args.request, callbackOrigin);
}

export function getConnectorOpenIdCallbackOrigin<
  Type extends OpenIdAuthGrantConnectorType,
>(args: {
  readonly request: Request;
  readonly type: Type;
  readonly authMethod: ConnectorOpenIdAuthGrantAuthMethodId<Type>;
}): string {
  const callbackOrigin = getConnectorAuthMethodOpenIdAuthCallbackOrigin(
    args.type,
    args.authMethod,
  );
  return resolveCallbackOrigin(args.request, callbackOrigin);
}

export function getConnectorOAuthCanonicalRedirectUrl(
  request: Request,
  type: AuthCodeGrantConnectorType,
): string | null {
  if (connectorAuthCodeCallbacksUseOnlyApiOrigin(type)) {
    return null;
  }
  return getOAuthCanonicalRedirectUrl(request);
}
