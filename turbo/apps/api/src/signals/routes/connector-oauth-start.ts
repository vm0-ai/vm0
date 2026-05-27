import {
  getConnectorOAuthClient,
  hasConnectorOAuthGrant,
  hasConnectorAuthCodeGrant,
  type ConnectorEnvReader,
  type ConnectorOAuthClient,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorType,
  AuthCodeGrantConnectorType,
} from "@vm0/connectors/connectors";
import {
  buildConnectorOAuthAuthUrl,
  hasConnectorOAuthProvider,
  type AuthUrlResult,
} from "@vm0/connectors/auth-providers";

import { generateConnectorOAuthState } from "./connector-oauth-route-state";

type PrepareResolvedConnectorOAuthStartResult =
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

type ResolveConnectorOAuthStartTypeResult =
  | {
      readonly ok: true;
      readonly type: AuthCodeGrantConnectorType;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "connector_does_not_use_oauth"
        | "oauth_provider_not_configured"
        | "unsupported_oauth_flow";
    };

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

export function resolveConnectorOAuthStartType(
  type: ConnectorType,
): ResolveConnectorOAuthStartTypeResult {
  if (!hasConnectorOAuthGrant(type)) {
    return { ok: false, reason: "connector_does_not_use_oauth" };
  }
  if (!hasConnectorOAuthProvider(type)) {
    return { ok: false, reason: "oauth_provider_not_configured" };
  }
  if (!hasConnectorAuthCodeGrant(type)) {
    return { ok: false, reason: "unsupported_oauth_flow" };
  }
  return { ok: true, type };
}

// Prepare only synchronous OAuth start data. Callers must resolve the route's
// ConnectorType first so non-OAuth connectors keep their route-specific errors,
// then build the provider authorization URL at the normal async commit point.
export function prepareResolvedConnectorOAuthStart(args: {
  readonly type: AuthCodeGrantConnectorType;
  readonly origin: string;
  readonly readEnv: ConnectorEnvReader;
}): PrepareResolvedConnectorOAuthStartResult {
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

export async function buildResolvedConnectorOAuthAuthResult(args: {
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
