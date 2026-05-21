import {
  getConnectorAuthMethod,
  getConnectorOAuthCredentials,
  type ConnectorEnvReader,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorType,
  OAuthConnectorType,
} from "@vm0/connectors/connectors";
import {
  buildConnectorOAuthAuthUrl,
  isOAuthConnectorType,
  type AuthUrlResult,
} from "@vm0/connectors/oauth-providers";

import { generateConnectorOAuthState } from "./connector-oauth-route-state";

type PrepareResolvedConnectorOAuthStartResult =
  | {
      readonly ok: true;
      readonly state: string;
      readonly redirectUri: string;
      readonly authResult: AuthUrlResult;
    }
  | {
      readonly ok: false;
      readonly reason: "oauth_not_configured";
    };

type ResolveConnectorOAuthStartTypeResult =
  | {
      readonly ok: true;
      readonly type: OAuthConnectorType;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "connector_does_not_use_oauth"
        | "oauth_provider_not_configured";
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
  return { ok: true, type };
}

// This helper intentionally prepares only provider-specific data. Callers must
// resolve the route's ConnectorType first so non-OAuth connectors keep their
// existing route-specific error responses.
export async function prepareResolvedConnectorOAuthStart(args: {
  readonly type: OAuthConnectorType;
  readonly origin: string;
  readonly readEnv: ConnectorEnvReader;
}): Promise<PrepareResolvedConnectorOAuthStartResult> {
  const state = generateConnectorOAuthState();
  const redirectUri = `${args.origin}/api/connectors/${args.type}/callback`;
  const credentials = getConnectorOAuthCredentials(args.type, args.readEnv);
  if (!credentials?.configured) {
    return { ok: false, reason: "oauth_not_configured" };
  }

  const authResult = normalizeAuthUrlResult(
    await buildConnectorOAuthAuthUrl({
      type: args.type,
      credentials,
      redirectUri,
      state,
    }),
  );

  return {
    ok: true,
    state,
    redirectUri,
    authResult,
  };
}
