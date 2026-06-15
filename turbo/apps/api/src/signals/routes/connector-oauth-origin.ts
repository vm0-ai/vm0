import {
  connectorAuthCodeCallbacksUseOnlyApiOrigin,
  getConnectorAuthMethodAuthCodeCallbackOrigin,
} from "@vm0/connectors/connector-utils";
import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantAuthMethodId,
} from "@vm0/connectors/connectors";

import {
  getOAuthApiOrigin,
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "./oauth-web-origin";

export { getOAuthWebOrigin as getConnectorOAuthOrigin };

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
  switch (callbackOrigin) {
    case "api": {
      return getOAuthApiOrigin(args.request);
    }
    case "web": {
      return getOAuthWebOrigin(args.request);
    }
  }
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
