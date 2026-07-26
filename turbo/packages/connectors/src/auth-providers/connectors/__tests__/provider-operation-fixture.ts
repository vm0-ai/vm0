import type {
  ConnectorAuthClient,
  ConnectorEnvReader,
} from "../../../connector-auth-method";
import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import {
  completeConnectorExternalCodeAuthorizationWithMethod,
  refreshConnectorAuthProviderAccessTokenWithMethod,
  revokeConnectorAuthMethodAccessTokenWithMethod,
  startConnectorExternalCodeAuthorizationWithMethod,
} from "../../connector-auth";

interface ProviderMethodFixture {
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}

function assertFixtureSelection(
  fixture: ProviderMethodFixture,
  args: { readonly type: string; readonly authMethod: string },
): void {
  if (
    args.type !== fixture.connectorRef ||
    args.authMethod !== fixture.authMethodId
  ) {
    throw new Error(
      `Expected provider fixture ${fixture.connectorRef}:${fixture.authMethodId}`,
    );
  }
}

export function providerOperationFixture(fixture: ProviderMethodFixture) {
  const selection = {
    connectorRef: fixture.connectorRef,
    authMethodId: fixture.authMethodId,
    method: fixture.method,
  };
  return {
    startConnectorExternalCodeAuthorization(args: {
      readonly type: string;
      readonly authMethod: string;
      readonly authClient: ConnectorAuthClient;
    }) {
      assertFixtureSelection(fixture, args);
      return startConnectorExternalCodeAuthorizationWithMethod({
        ...selection,
        authClient: args.authClient,
      });
    },
    completeConnectorExternalCodeAuthorization(args: {
      readonly type: string;
      readonly authMethod: string;
      readonly authClient: ConnectorAuthClient;
      readonly code: string;
      readonly providerState: string;
      readonly signal: AbortSignal;
    }) {
      assertFixtureSelection(fixture, args);
      return completeConnectorExternalCodeAuthorizationWithMethod({
        ...selection,
        authClient: args.authClient,
        code: args.code,
        providerState: args.providerState,
        signal: args.signal,
      });
    },
    refreshConnectorAuthProviderAccessToken(args: {
      readonly type: string;
      readonly authMethod: string;
      readonly authClient?: ConnectorAuthClient;
      readonly inputs: Readonly<Record<string, string>>;
      readonly signal: AbortSignal;
    }) {
      assertFixtureSelection(fixture, args);
      return refreshConnectorAuthProviderAccessTokenWithMethod({
        ...selection,
        ...(args.authClient === undefined
          ? {}
          : { authClient: args.authClient }),
        inputs: args.inputs,
        signal: args.signal,
      });
    },
    revokeConnectorAuthMethodAccessToken(args: {
      readonly type: string;
      readonly authMethod: string;
      readonly readEnv: ConnectorEnvReader;
      readonly signal: AbortSignal;
      readonly loadInputs: () =>
        | Readonly<Record<string, string>>
        | Promise<Readonly<Record<string, string>>>;
    }) {
      assertFixtureSelection(fixture, args);
      return revokeConnectorAuthMethodAccessTokenWithMethod({
        ...selection,
        readEnv: args.readEnv,
        signal: args.signal,
        loadInputs: args.loadInputs,
      });
    },
  };
}
