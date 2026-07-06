import {
  connectorAuthMethodRefHasGrantKind,
  getConnectorAuthMethod,
  type ConnectorAuthMethodRefByGrantKind,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
  OpenIdAuthGrantConnectorType,
  ConnectorOpenIdAuthGrantAuthMethodId,
} from "@vm0/connectors/connectors";
import { buildConnectorOpenIdAuthAuthorizationUrl } from "@vm0/connectors/auth-providers";
import type { AuthUrlResult } from "@vm0/connectors/auth-providers/provider-flow-types";

import { generateConnectorOAuthState } from "./connector-oauth-route-state";

type PrepareResolvedConnectorOpenIdAuthStartResult = {
  readonly ok: true;
  readonly state: string;
  readonly returnTo: string;
  readonly realm: string;
  readonly expectedReturnTo: string;
};

type ResolveConnectorOpenIdAuthStartMethodResult =
  | ({ readonly ok: true } & ConnectorAuthMethodRefByGrantKind<"openid-auth">)
  | {
      readonly ok: false;
      readonly reason: "missing_auth_method" | "wrong_grant_kind";
    };

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

export function openIdRealmForOrigin(origin: string): string {
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolveConnectorOpenIdAuthStartMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ResolveConnectorOpenIdAuthStartMethodResult {
  const authMethodRef = { type, authMethod };
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return { ok: false, reason: "missing_auth_method" };
  }
  if (!connectorAuthMethodRefHasGrantKind(authMethodRef, "openid-auth")) {
    return { ok: false, reason: "wrong_grant_kind" };
  }

  return { ok: true, ...authMethodRef };
}

export function prepareResolvedConnectorOpenIdAuthStart<
  Type extends OpenIdAuthGrantConnectorType,
>(args: {
  readonly type: Type;
  readonly origin: string;
}): PrepareResolvedConnectorOpenIdAuthStartResult {
  const state = generateConnectorOAuthState();
  const returnTo = new URL(
    `/api/connectors/${args.type}/callback`,
    args.origin,
  );
  returnTo.searchParams.set("state", state);

  return {
    ok: true,
    state,
    returnTo: returnTo.toString(),
    expectedReturnTo: returnTo.toString(),
    realm: openIdRealmForOrigin(args.origin),
  };
}

export async function buildResolvedConnectorOpenIdAuthUrl<
  Type extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<Type>,
>(args: {
  readonly type: Type;
  readonly authMethod: Method;
  readonly returnTo: string;
  readonly realm: string;
  readonly state: string;
}): Promise<AuthUrlResult> {
  return normalizeAuthUrlResult(
    await buildConnectorOpenIdAuthAuthorizationUrl({
      type: args.type,
      authMethod: args.authMethod,
      returnTo: args.returnTo,
      realm: args.realm,
      state: args.state,
    }),
  );
}
