import {
  resolveConnectorAuthClient,
  type ConnectorEnvReader,
} from "@okouai/connectors/connector-auth-method";
import type {
  ConnectorAuthMethodRuntimeConfig,
  ConnectorAuthClientConfig,
} from "@okouai/connectors/connector-config";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { buildConnectorAuthCodeAuthorizationUrlWithMethod } from "@okouai/connectors/auth-providers";
import type { AuthUrlResult } from "@okouai/connectors/auth-providers/provider-flow-types";

import { generateConnectorOAuthState } from "../../lib/connector-oauth-state";
import { encryptPersistentSecretsMap } from "../services/crypto.utils";

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

function parseConnectorOAuthClientInputs(
  client: ConnectorAuthClientConfig | undefined,
  oauthClient:
    | { readonly clientId: string; readonly clientSecret: string }
    | undefined,
):
  | {
      readonly ok: true;
      readonly inputs: Readonly<Record<string, string>> | undefined;
    }
  | { readonly ok: false; readonly message: string } {
  if (!client || !("clientIdInput" in client)) {
    return oauthClient === undefined
      ? { ok: true, inputs: undefined }
      : {
          ok: false,
          message:
            "This authorization method does not accept client credentials",
        };
  }
  if (!oauthClient) {
    return {
      ok: false,
      message:
        "Client ID and Client Secret are required for this authorization method",
    };
  }
  return {
    ok: true,
    inputs: {
      [client.clientIdInput]: oauthClient.clientId,
      [client.clientSecretInput]: oauthClient.clientSecret,
    },
  };
}

type PrepareConnectorAuthCodeStartWithMethodResult =
  | {
      readonly ok: true;
      readonly state: string;
      readonly redirectUri: string;
      readonly authResult: AuthUrlResult;
      readonly encryptedAuthClient: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "auth_client_not_configured" | "invalid_client_inputs";
      readonly message: string;
    };

export async function prepareConnectorAuthCodeStartWithMethod(
  args: {
    readonly connectorSlug: string;
    readonly authMethodId: string;
    readonly method: ConnectorAuthMethodRuntimeConfig;
    readonly redirectUri: string;
    readonly readEnv: ConnectorEnvReader;
    readonly oauthClient?: {
      readonly clientId: string;
      readonly clientSecret: string;
    };
    readonly publicBrand: PublicBrand;
  },
  signal: AbortSignal,
): Promise<PrepareConnectorAuthCodeStartWithMethodResult> {
  if (args.method.grant.kind !== "auth-code" || !args.method.client) {
    return {
      ok: false,
      reason: "auth_client_not_configured",
      message: "Connector execution is not configured",
    };
  }
  const clientInputs = parseConnectorOAuthClientInputs(
    args.method.client,
    args.oauthClient,
  );
  if (!clientInputs.ok) {
    return {
      ok: false,
      reason: "invalid_client_inputs",
      message: clientInputs.message,
    };
  }
  const authClient = resolveConnectorAuthClient(
    args.method.client,
    args.readEnv,
    clientInputs.inputs,
  );
  if (!authClient) {
    return {
      ok: false,
      reason: "auth_client_not_configured",
      message: `${args.connectorSlug} auth client not configured`,
    };
  }
  const state = generateConnectorOAuthState(args.publicBrand);
  const authResult = normalizeAuthUrlResult(
    await buildConnectorAuthCodeAuthorizationUrlWithMethod({
      connectorSlug: args.connectorSlug,
      authMethodId: args.authMethodId,
      method: args.method,
      authClient,
      redirectUri: args.redirectUri,
      state,
    }),
  );
  signal.throwIfAborted();
  const encryptedAuthClient = await encryptPersistentSecretsMap(
    clientInputs.inputs,
    {},
  );
  signal.throwIfAborted();
  return {
    ok: true,
    state,
    redirectUri: args.redirectUri,
    authResult,
    encryptedAuthClient,
  };
}
