import {
  connectorAuthMethodRefHasGrantKind,
  getConnectorAuthMethod,
  resolveConnectorAuthClientForMethod,
  type ConnectorEnvReader,
  type ConnectorAuthMethodRefByGrantKind,
  type ConnectorAuthClientForMethod,
} from "@vm0/connectors/connector-utils";
import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { buildConnectorAuthCodeAuthorizationUrl } from "@vm0/connectors/auth-providers";
import type { AuthUrlResult } from "@vm0/connectors/auth-providers/oauth/types";

import { generateConnectorOAuthState } from "./connector-oauth-route-state";

type PrepareResolvedConnectorAuthCodeStartResult<
  Type extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type>,
> =
  | {
      readonly ok: true;
      readonly state: string;
      readonly redirectUri: string;
      readonly authClient: ConnectorAuthClientForMethod<Type, Method>;
    }
  | {
      readonly ok: false;
      readonly reason: "auth_client_not_configured";
    };

type ResolveConnectorAuthCodeStartMethodResult =
  | ({ readonly ok: true } & ConnectorAuthMethodRefByGrantKind<"auth-code">)
  | {
      readonly ok: false;
      readonly reason: "missing_auth_method" | "wrong_grant_kind";
    };

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

export function resolveConnectorAuthCodeStartMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ResolveConnectorAuthCodeStartMethodResult {
  const authMethodRef = { type, authMethod };
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return { ok: false, reason: "missing_auth_method" };
  }
  if (!connectorAuthMethodRefHasGrantKind(authMethodRef, "auth-code")) {
    return { ok: false, reason: "wrong_grant_kind" };
  }

  return { ok: true, ...authMethodRef };
}

// Prepare only synchronous auth-code start data after callers have validated
// the selected auth method for this auth-code flow.
export function prepareResolvedConnectorAuthCodeStart<
  Type extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type>,
>(args: {
  readonly type: Type;
  readonly authMethod: Method;
  readonly origin: string;
  readonly readEnv: ConnectorEnvReader;
}): PrepareResolvedConnectorAuthCodeStartResult<Type, Method> {
  const state = generateConnectorOAuthState();
  const redirectUri = `${args.origin}/api/connectors/${args.type}/callback`;
  const authClient = resolveConnectorAuthClientForMethod(
    args.type,
    args.authMethod,
    args.readEnv,
  );
  if (!authClient) {
    return { ok: false, reason: "auth_client_not_configured" };
  }

  return {
    ok: true,
    state,
    redirectUri,
    authClient,
  };
}

export async function buildResolvedConnectorAuthCodeAuthUrl<
  Type extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type>,
>(args: {
  readonly type: Type;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<Type, Method>;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<AuthUrlResult> {
  return normalizeAuthUrlResult(
    await buildConnectorAuthCodeAuthorizationUrl({
      type: args.type,
      authMethod: args.authMethod,
      authClient: args.authClient,
      redirectUri: args.redirectUri,
      state: args.state,
    }),
  );
}
