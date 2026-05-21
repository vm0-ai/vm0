import {
  getConnectorAuthMethod,
  getConnectorOAuthCredentials,
  isOAuthAuthorizationCodeConnectorType,
  type ConnectorEnvReader,
  type ConnectorOAuthCredentials,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorType,
  OAuthAuthorizationCodeConnectorType,
} from "@vm0/connectors/connectors";
import {
  buildConnectorOAuthAuthUrl,
  isOAuthConnectorType,
  type AuthUrlResult,
} from "@vm0/connectors/oauth-providers";

import { generateConnectorOAuthState } from "./connector-oauth-route-state";

type ConfiguredConnectorOAuthCredentials = Extract<
  ConnectorOAuthCredentials,
  { readonly configured: true }
>;

type PrepareResolvedConnectorOAuthStartResult =
  | {
      readonly ok: true;
      readonly state: string;
      readonly redirectUri: string;
      readonly credentials: ConfiguredConnectorOAuthCredentials;
    }
  | {
      readonly ok: false;
      readonly reason: "oauth_not_configured";
    };

type ResolveConnectorOAuthStartTypeResult =
  | {
      readonly ok: true;
      readonly type: OAuthAuthorizationCodeConnectorType;
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
  if (!getConnectorAuthMethod(type, "oauth")) {
    return { ok: false, reason: "connector_does_not_use_oauth" };
  }
  if (!isOAuthConnectorType(type)) {
    return { ok: false, reason: "oauth_provider_not_configured" };
  }
  if (!isOAuthAuthorizationCodeConnectorType(type)) {
    return { ok: false, reason: "unsupported_oauth_flow" };
  }
  return { ok: true, type };
}

// Prepare only synchronous OAuth start data. Callers must resolve the route's
// ConnectorType first so non-OAuth connectors keep their route-specific errors,
// then build the provider authorization URL at the normal async commit point.
export function prepareResolvedConnectorOAuthStart(args: {
  readonly type: OAuthAuthorizationCodeConnectorType;
  readonly origin: string;
  readonly readEnv: ConnectorEnvReader;
}): PrepareResolvedConnectorOAuthStartResult {
  const state = generateConnectorOAuthState();
  const redirectUri = `${args.origin}/api/connectors/${args.type}/callback`;
  const credentials = getConnectorOAuthCredentials(args.type, args.readEnv);
  if (!credentials?.configured) {
    return { ok: false, reason: "oauth_not_configured" };
  }

  return {
    ok: true,
    state,
    redirectUri,
    credentials,
  };
}

export async function buildResolvedConnectorOAuthAuthResult(args: {
  readonly type: OAuthAuthorizationCodeConnectorType;
  readonly credentials: ConfiguredConnectorOAuthCredentials;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<AuthUrlResult> {
  return normalizeAuthUrlResult(
    await buildConnectorOAuthAuthUrl({
      type: args.type,
      credentials: args.credentials,
      redirectUri: args.redirectUri,
      state: args.state,
    }),
  );
}
