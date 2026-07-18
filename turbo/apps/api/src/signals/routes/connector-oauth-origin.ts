import {
  connectorAuthCodeGrantCallbackOrigin,
  connectorOpenIdAuthGrantCallbackOrigin,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorAuthMethodRuntimeConfig,
  ConnectorBrowserAuthCallbackOrigin,
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

export function getConnectorOAuthCallbackOriginForMethod(args: {
  readonly request: Request;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}): string {
  if (args.method.grant.kind !== "auth-code") {
    throw new Error("Auth-code connector method required");
  }
  return resolveCallbackOrigin(
    args.request,
    connectorAuthCodeGrantCallbackOrigin(args.method.grant),
  );
}

export function getConnectorOpenIdCallbackOriginForMethod(args: {
  readonly request: Request;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}): string {
  if (args.method.grant.kind !== "openid-auth") {
    throw new Error("OpenID connector method required");
  }
  return resolveCallbackOrigin(
    args.request,
    connectorOpenIdAuthGrantCallbackOrigin(args.method.grant),
  );
}

export function getConnectorOAuthCanonicalRedirectUrlForMethods(
  request: Request,
  methods: readonly ConnectorAuthMethodRuntimeConfig[],
): string | null {
  const authCodeMethods = methods.filter(
    (
      method,
    ): method is Extract<
      ConnectorAuthMethodRuntimeConfig,
      { readonly grant: { readonly kind: "auth-code" } }
    > => {
      return method.grant.kind === "auth-code";
    },
  );
  if (
    authCodeMethods.every((method) => {
      return connectorAuthCodeGrantCallbackOrigin(method.grant) === "api";
    })
  ) {
    return null;
  }
  return getOAuthCanonicalRedirectUrl(request);
}
