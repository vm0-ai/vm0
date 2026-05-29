import {
  getConnectorAuthMethodIdForGrantKind,
  getConnectorOAuthClient,
  hasConnectorAuthCodeGrant,
  type ConnectorEnvReader,
  type ConnectorOAuthClient,
} from "@vm0/connectors/connector-utils";
import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import {
  buildConnectorOAuthAuthUrl,
  type AuthUrlResult,
} from "@vm0/connectors/auth-providers";

import { generateConnectorOAuthState } from "./connector-oauth-route-state";

type PrepareResolvedConnectorAuthCodeStartResult =
  | {
      readonly ok: true;
      readonly state: string;
      readonly redirectUri: string;
      readonly oauthClient: ConnectorOAuthClient;
    }
  | {
      readonly ok: false;
      readonly reason: "oauth_not_configured";
    };

type ResolveConnectorAuthCodeStartTypeResult =
  | {
      readonly ok: true;
      readonly type: AuthCodeGrantConnectorType;
      readonly authMethod: ConnectorAuthMethodId;
    }
  | {
      readonly ok: false;
      readonly reason: "missing_auth_code_grant";
    };

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

export function resolveConnectorAuthCodeStartType(
  type: ConnectorType,
): ResolveConnectorAuthCodeStartTypeResult {
  if (!hasConnectorAuthCodeGrant(type)) {
    return { ok: false, reason: "missing_auth_code_grant" };
  }
  const authMethod = getConnectorAuthMethodIdForGrantKind(type, "auth-code");
  if (!authMethod) {
    throw new Error(`${type} connector has no auth-code auth method`);
  }
  return { ok: true, type, authMethod };
}

// Prepare only synchronous auth-code start data. Callers must resolve the route's
// ConnectorType first so connectors without interactive grants keep their
// route-specific errors, then build the provider authorization URL at the
// normal async commit point.
export function prepareResolvedConnectorAuthCodeStart(args: {
  readonly type: AuthCodeGrantConnectorType;
  readonly origin: string;
  readonly readEnv: ConnectorEnvReader;
}): PrepareResolvedConnectorAuthCodeStartResult {
  const state = generateConnectorOAuthState();
  const redirectUri = `${args.origin}/api/connectors/${args.type}/callback`;
  const oauthClient = getConnectorOAuthClient(args.type, args.readEnv);
  if (!oauthClient) {
    return { ok: false, reason: "oauth_not_configured" };
  }

  return {
    ok: true,
    state,
    redirectUri,
    oauthClient,
  };
}

export async function buildResolvedConnectorAuthCodeAuthUrl(args: {
  readonly type: AuthCodeGrantConnectorType;
  readonly oauthClient: ConnectorOAuthClient;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<AuthUrlResult> {
  return normalizeAuthUrlResult(
    await buildConnectorOAuthAuthUrl({
      type: args.type,
      oauthClient: args.oauthClient,
      redirectUri: args.redirectUri,
      state: args.state,
    }),
  );
}
