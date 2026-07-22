import {
  type ConnectorAuthCodeGrantAuthMethodId,
  type AuthCodeGrantConnectorType,
  type ConnectorRegistryAuthMethodId,
  type ConnectorAuthMethodRuntimeConfig,
  type ConnectorType,
  type ConnectorDeviceAuthGrantAuthMethodId,
  type ConnectorExternalCodeGrantAuthMethodId,
  type ConnectorOpenIdAuthGrantAuthMethodId,
  type ConnectorDeviceAuthStartOptions,
  type ConnectorAuthMethodIdsByGrantKind,
  type DeviceAuthGrantConnectorType,
  type ExternalCodeGrantConnectorType,
  type OpenIdAuthGrantConnectorType,
  type ConnectorAuthMethodIdsByAccessKind,
  type ConnectorAuthMethodIdsByRevokeKind,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorExternalCodeGrantConfig,
  type ConnectorOpenIdAuthGrantConfig,
  type ConnectorRefreshInputValues,
  type RefreshTokenAccessConnectorType,
  type TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import {
  connectorAuthClientIdentity,
  connectorAuthMethodAccessMetadata,
  connectorGrantScopes,
  getConnectorAuthMethod,
  isStaticConnectorAuthClient,
  parseConnectorDeviceAuthStartOptionsConfig,
  resolveConnectorAuthClient,
  type ConnectorAuthClient,
  type ConnectorAuthClientIdentity,
  type ConnectorAuthClientForMethod,
  type ConnectorResolvedAuthMethodClientByGrantKind,
  type ConnectorEnvReader,
  type StaticConnectorAuthClient,
} from "@vm0/connectors/connector-utils";
import type {
  AuthCodeConnectorAuthProvider,
  ConnectorAuthProviderRefreshArgs,
  ConnectorAuthProviderRefreshResultBase,
  ConnectorAuthProviderRefreshResult,
  DeviceAuthConnectorAuthProvider,
  ExternalCodeConnectorAuthProvider,
  OpenIdAuthConnectorAuthProvider,
  RefreshTokenAccessProvider,
  TokenRevokeProvider,
} from "./types";
import type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantResultForMethod,
} from "./grant-result";
import {
  type AuthUrlResult,
  type ExternalCodeAuthorizationStartResult,
  type OAuthDeviceAuthPollResult,
  type OAuthDeviceAuthPollResultBase,
  type OAuthDeviceAuthStartResult,
} from "./provider-flow-types";
import { providerEnvFromObject, type ProviderEnv } from "./provider-env";
import { ahrefsProvider } from "./connectors/ahrefs/provider";
import { airtableProvider } from "./connectors/airtable/provider";
import { asanaProvider } from "./connectors/asana/provider";
import { awsProvider } from "./connectors/aws/provider";
import { base44Provider } from "./connectors/base44/provider";
import { boxProvider } from "./connectors/box/provider";
import { calComProvider } from "./connectors/cal-com/provider";
import { canvaProvider } from "./connectors/canva/provider";
import { closeProvider } from "./connectors/close/provider";
import { copperProvider } from "./connectors/copper/provider";
import { cloudflareProvider } from "./connectors/cloudflare/provider";
import { deelProvider } from "./connectors/deel/provider";
import { datadogProvider } from "./connectors/datadog/provider";
import { docusignProvider } from "./connectors/docusign/provider";
import { dropboxProvider } from "./connectors/dropbox/provider";
import { figmaProvider } from "./connectors/figma/provider";
import { garminConnectProvider } from "./connectors/garmin-connect/provider";
import { gumroadProvider } from "./connectors/gumroad/provider";
import { githubProvider } from "./connectors/github/provider";
import { gmailProvider } from "./connectors/gmail/provider";
import { hubspotProvider } from "./connectors/hubspot/provider";
import { googleAdsProvider } from "./connectors/google-ads/provider";
import { googleAnalyticsProvider } from "./connectors/google-analytics/provider";
import { googleCalendarProvider } from "./connectors/google-calendar/provider";
import { googleCloudProvider } from "./connectors/google-cloud/provider";
import { googleContactsProvider } from "./connectors/google-contacts/provider";
import { googleDocsProvider } from "./connectors/google-docs/provider";
import { googleDriveProvider } from "./connectors/google-drive/provider";
import { googleFormsProvider } from "./connectors/google-forms/provider";
import { googleMapsProvider } from "./connectors/google-maps/provider";
import { googleMeetProvider } from "./connectors/google-meet/provider";
import { googleSearchConsoleProvider } from "./connectors/google-search-console/provider";
import { googleSheetsProvider } from "./connectors/google-sheets/provider";
import { larkProvider } from "./connectors/lark/provider";
import { linearProvider } from "./connectors/linear/provider";
import { mailchimpProvider } from "./connectors/mailchimp/provider";
import { mercuryProvider } from "./connectors/mercury/provider";
import { microsoft365Provider } from "./connectors/microsoft-365/provider";
import { mondayProvider } from "./connectors/monday/provider";
import { neonProvider } from "./connectors/neon/provider";
import { nintendoSwitchParentalControlsProvider } from "./connectors/nintendo-switch-parental-controls/provider";
import { nintendoStoreProvider } from "./connectors/nintendo-store/provider";
import { notionProvider } from "./connectors/notion/provider";
import { netsuiteProvider } from "./connectors/netsuite/provider";
import { outlookCalendarProvider } from "./connectors/outlook-calendar/provider";
import { outlookMailProvider } from "./connectors/outlook-mail/provider";
import { redditProvider } from "./connectors/reddit/provider";
import { intervalsIcuProvider } from "./connectors/intervals-icu/provider";
import { sentryProvider } from "./connectors/sentry/provider";
import { slackProvider } from "./connectors/slack/provider";
import { slockProvider } from "./connectors/slock/provider";
import { stravaProvider } from "./connectors/strava/provider";
import {
  stripeCliProvider,
  stripeProvider,
} from "./connectors/stripe/provider";
import { todoistProvider } from "./connectors/todoist/provider";
import { vercelProvider } from "./connectors/vercel/provider";
import { webflowProvider } from "./connectors/webflow/provider";
import { supabaseProvider } from "./connectors/supabase/provider";
import { metaAdsProvider } from "./connectors/meta-ads/provider";
import { posthogProvider } from "./connectors/posthog/provider";
import { paypalProvider } from "./connectors/paypal/provider";
import { quickbooksProvider } from "./connectors/quickbooks/provider";
import { rampProvider } from "./connectors/ramp/provider";
import { playstationProvider } from "./connectors/playstation/provider";
import { spotifyProvider } from "./connectors/spotify/provider";
import { steamProvider } from "./connectors/steam/provider";
import { tiktokAdsProvider } from "./connectors/tiktok-ads/provider";
import { xProvider } from "./connectors/x/provider";
import { xeroProvider } from "./connectors/xero/provider";
import { youtubeProvider } from "./connectors/youtube/provider";
import { zoomProvider } from "./connectors/zoom/provider";
import { workdayProvider } from "./connectors/workday/provider";
import {
  testOauthApiTokenProvider,
  testOauthApiProvider,
  testOauthProvider,
} from "./connectors/test-oauth/provider";
import {
  testOauthDeviceApiProvider,
  testOauthDeviceProvider,
} from "./connectors/test-oauth-device/provider";

export type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantResultForMethod,
  ConnectorAuthProviderRefreshResultBase,
  ConnectorAuthProviderRefreshResult,
};
export type { ProviderEnv };
export { providerEnvFromObject };

export type ConnectorAuthProviderAccessTokenRevokeResult =
  | { readonly status: "revoked" }
  | { readonly status: "unsupported" };

type ConnectorAuthMethodIdsWithoutProviderGrant<Type extends ConnectorType> =
  Exclude<
    ConnectorRegistryAuthMethodId,
    | ConnectorAuthMethodIdsByGrantKind<
        Type & AuthCodeGrantConnectorType,
        "auth-code"
      >
    | ConnectorAuthMethodIdsByGrantKind<
        Type & DeviceAuthGrantConnectorType,
        "device-auth"
      >
    | ConnectorAuthMethodIdsByGrantKind<
        Type & OpenIdAuthGrantConnectorType,
        "openid-auth"
      >
    | ConnectorAuthMethodIdsByGrantKind<
        Type & ExternalCodeGrantConnectorType,
        "external-code"
      >
  >;

type ConnectorAuthMethodIdsWithoutRefreshTokenAccess<
  Type extends ConnectorType,
> = Exclude<
  ConnectorRegistryAuthMethodId,
  ConnectorAuthMethodIdsByAccessKind<
    Type & RefreshTokenAccessConnectorType,
    "refresh-token"
  >
>;

type ConnectorAuthMethodIdsWithoutTokenRevoke<Type extends ConnectorType> =
  Exclude<
    ConnectorRegistryAuthMethodId,
    ConnectorAuthMethodIdsByRevokeKind<
      Type & TokenRevokeConnectorType,
      "token-revoke"
    >
  >;

type RuntimeAuthCodeGrantProvider = {
  readonly kind: "auth-code";
  buildAuthUrl(
    args: never,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(args: never): Promise<ConnectorAuthProviderGrantResult>;
};

type RuntimeDeviceAuthGrantProvider = {
  readonly kind: "device-auth";
  startDeviceAuth(args: never): Promise<OAuthDeviceAuthStartResult>;
  pollDeviceAuth(args: never): Promise<OAuthDeviceAuthPollResultBase>;
};

type RuntimeOpenIdAuthGrantProvider = {
  readonly kind: "openid-auth";
  buildAuthUrl(
    args: never,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  verifyCallback(args: never): Promise<ConnectorAuthProviderGrantResult>;
};

type RuntimeExternalCodeGrantProvider = {
  readonly kind: "external-code";
  startExternalCodeAuthorization(
    args: never,
  ): Promise<ExternalCodeAuthorizationStartResult>;
  completeExternalCodeAuthorization(
    args: never,
  ): Promise<ConnectorAuthProviderGrantResult>;
};

type RuntimeGrantProvider =
  | RuntimeAuthCodeGrantProvider
  | RuntimeDeviceAuthGrantProvider
  | RuntimeOpenIdAuthGrantProvider
  | RuntimeExternalCodeGrantProvider;

type RuntimeRefreshTokenAccessProvider = {
  readonly kind: "refresh-token";
  refresh(args: never): Promise<ConnectorAuthProviderRefreshResultBase>;
};

type RuntimeTokenRevokeProvider = {
  readonly kind: "token-revoke";
  revokeToken(args: never): Promise<void>;
};

type RuntimeAuthProviderEntry = {
  readonly grant?: RuntimeGrantProvider;
  readonly access?: RuntimeRefreshTokenAccessProvider;
  readonly revoke?: RuntimeTokenRevokeProvider;
};

type RuntimeAuthProviderRegistration<
  Type extends ConnectorType = ConnectorType,
  Method extends ConnectorRegistryAuthMethodId = ConnectorRegistryAuthMethodId,
> = {
  readonly type: Type;
  readonly authMethod: Method;
  readonly entry: RuntimeAuthProviderEntry;
};

type PreparedRuntimeAuthProviderRegistration =
  RuntimeAuthProviderRegistration & {
    readonly capability: ConnectorAuthProviderRegistrationCapability;
  };

type RuntimeAuthProviderRegistry = ReadonlyMap<
  string,
  PreparedRuntimeAuthProviderRegistration
>;

export type ConnectorAuthProviderRegistryCapability = {
  readonly grant?: RuntimeGrantProvider["kind"];
  readonly access?: RuntimeRefreshTokenAccessProvider["kind"];
  readonly revoke?: RuntimeTokenRevokeProvider["kind"];
};

export type ConnectorAuthProviderRegistryCapabilities = Readonly<
  Partial<
    Record<
      ConnectorType,
      Readonly<
        Partial<
          Record<
            ConnectorRegistryAuthMethodId,
            ConnectorAuthProviderRegistryCapability
          >
        >
      >
    >
  >
>;

export const CONNECTOR_GENERIC_AUTH_CAPABILITY_VERSIONS = {
  manualGrant: 1,
  staticAccess: 1,
  noneRevoke: 1,
} as const;

export type ConnectorAuthProviderClientContract =
  | { readonly kind: "none" }
  | {
      readonly kind: "static-confidential-env";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  | { readonly kind: "static-confidential-literal" }
  | {
      readonly kind: "static-public-env";
      readonly clientIdEnv: string;
    }
  | { readonly kind: "static-public-literal" }
  | { readonly kind: "dynamic-public" };

export interface ConnectorAuthProviderMethodContract {
  readonly client: ConnectorAuthProviderClientContract;
  readonly grant: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["grant"]["kind"];
    readonly callbackOrigin: "web" | "api" | null;
    readonly outputNames: readonly string[];
    readonly startOptionNames: readonly string[];
  };
  readonly access: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["access"]["kind"];
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    readonly platformSecrets: readonly string[];
  };
  readonly revoke: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["revoke"]["kind"];
    readonly inputNames: readonly string[];
  };
}

export interface ConnectorAuthProviderRegistrationCapability {
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly handlers: ConnectorAuthProviderRegistryCapability;
  readonly contract: ConnectorAuthProviderMethodContract;
  readonly requiredConfigurationNames: readonly string[];
}

function compareCapabilityStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function connectorAuthProviderClientContract(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthProviderClientContract {
  const client = method.client;
  if (client === undefined) {
    return { kind: "none" };
  }
  if (client.clientRegistration === "dynamic") {
    return { kind: "dynamic-public" };
  }
  if (client.clientType === "confidential") {
    return "clientIdEnv" in client
      ? {
          kind: "static-confidential-env",
          clientIdEnv: client.clientIdEnv,
          clientSecretEnv: client.clientSecretEnv,
        }
      : { kind: "static-confidential-literal" };
  }
  return "clientIdEnv" in client
    ? { kind: "static-public-env", clientIdEnv: client.clientIdEnv }
    : { kind: "static-public-literal" };
}

function connectorAuthProviderMethodContract(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthProviderMethodContract {
  const callbackOrigin =
    method.grant.kind === "auth-code"
      ? (method.grant.callbackOrigin ?? "web")
      : method.grant.kind === "openid-auth"
        ? (method.grant.callbackOrigin ?? "api")
        : null;
  const grantOutputNames =
    method.grant.kind === "auth-code" ||
    method.grant.kind === "openid-auth" ||
    method.grant.kind === "external-code" ||
    method.grant.kind === "device-auth"
      ? Object.keys(method.grant.outputs).sort(compareCapabilityStrings)
      : [];
  const startOptionNames =
    method.grant.kind === "device-auth"
      ? Object.keys(method.grant.startOptions ?? {}).sort(
          compareCapabilityStrings,
        )
      : [];
  const accessInputNames =
    method.access.kind === "refresh-token"
      ? Object.keys(method.access.inputs).sort(compareCapabilityStrings)
      : [];
  const accessOutputNames =
    method.access.kind === "refresh-token"
      ? Object.keys(method.access.outputs).sort(compareCapabilityStrings)
      : [];
  const revokeInputNames =
    method.revoke.kind === "token-revoke"
      ? Object.keys(method.revoke.inputs).sort(compareCapabilityStrings)
      : [];

  return {
    client: connectorAuthProviderClientContract(method),
    grant: {
      kind: method.grant.kind,
      callbackOrigin,
      outputNames: grantOutputNames,
      startOptionNames,
    },
    access: {
      kind: method.access.kind,
      inputNames: accessInputNames,
      outputNames: accessOutputNames,
      platformSecrets:
        method.access.kind === "none"
          ? []
          : [...(method.access.platformSecrets ?? [])].sort(
              compareCapabilityStrings,
            ),
    },
    revoke: {
      kind: method.revoke.kind,
      inputNames: revokeInputNames,
    },
  };
}

function connectorAuthProviderRequiredConfigurationNames(
  method: ConnectorAuthMethodRuntimeConfig,
): readonly string[] {
  const names = new Set<string>();
  const client = method.client;
  if (client?.clientRegistration === "static" && "clientIdEnv" in client) {
    names.add(client.clientIdEnv);
    if (client.clientType === "confidential") {
      names.add(client.clientSecretEnv);
    }
  }
  if (method.access.kind !== "none") {
    for (const name of method.access.platformSecrets ?? []) {
      names.add(name);
    }
  }
  return [...names].sort(compareCapabilityStrings);
}

function connectorAuthProviderRegistryCapability(
  entry: RuntimeAuthProviderEntry,
): ConnectorAuthProviderRegistryCapability {
  return {
    ...(entry.grant === undefined ? {} : { grant: entry.grant.kind }),
    ...(entry.access === undefined ? {} : { access: entry.access.kind }),
    ...(entry.revoke === undefined ? {} : { revoke: entry.revoke.kind }),
  };
}

function connectorAuthProviderRegistrationCapability(
  registration: RuntimeAuthProviderRegistration,
): ConnectorAuthProviderRegistrationCapability {
  const method = getConnectorAuthMethod(
    registration.type,
    registration.authMethod,
  );
  if (method === undefined) {
    throw new Error(
      `Missing auth method configuration for ${registration.type}:${registration.authMethod}`,
    );
  }
  return {
    connectorRef: registration.type,
    authMethodId: registration.authMethod,
    handlers: connectorAuthProviderRegistryCapability(registration.entry),
    contract: connectorAuthProviderMethodContract(method),
    requiredConfigurationNames:
      connectorAuthProviderRequiredConfigurationNames(method),
  };
}

type MutableConnectorAuthProviderRegistryCapabilities = Partial<
  Record<
    ConnectorType,
    Partial<
      Record<
        ConnectorRegistryAuthMethodId,
        ConnectorAuthProviderRegistryCapability
      >
    >
  >
>;

function connectorAuthProviderRegistryEntry<
  Type extends ConnectorType,
  Method extends ConnectorRegistryAuthMethodId,
>(
  type: Type,
  authMethod: Method,
  entry: RuntimeAuthProviderEntry,
): RuntimeAuthProviderRegistration<Type, Method> {
  return { type, authMethod, entry };
}

function buildRuntimeProviderRegistry(
  registrations: readonly RuntimeAuthProviderRegistration[],
): RuntimeAuthProviderRegistry {
  const registry = new Map<string, PreparedRuntimeAuthProviderRegistration>();
  for (const registration of registrations) {
    const key = connectorAuthProviderRegistrationKey(
      registration.type,
      registration.authMethod,
    );
    if (registry.has(key)) {
      throw new Error(
        `Duplicate auth provider registration for ${registration.type}:${registration.authMethod}`,
      );
    }
    registry.set(key, {
      ...registration,
      capability: connectorAuthProviderRegistrationCapability(registration),
    });
  }
  return registry;
}

function connectorAuthProviderRegistrationKey(
  connectorRef: string,
  authMethodId: string,
): string {
  return `${connectorRef}\0${authMethodId}`;
}

function getRuntimeAuthProviderRegistration(
  connectorRef: string,
  authMethodId: string,
): PreparedRuntimeAuthProviderRegistration {
  const registration = CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY.get(
    connectorAuthProviderRegistrationKey(connectorRef, authMethodId),
  );
  if (registration === undefined) {
    throw new Error(
      `Missing auth provider registration for ${connectorRef}:${authMethodId}`,
    );
  }
  return registration;
}

function authCodeProviderEntry<
  Type extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsWithoutRefreshTokenAccess<Type> &
    ConnectorAuthMethodIdsWithoutTokenRevoke<Type>,
>(
  type: Type,
  authMethod: Method,
  provider: AuthCodeConnectorAuthProvider<Type, Method>,
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
  });
}

function authCodeRefreshProviderEntry<
  Type extends AuthCodeGrantConnectorType & RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token"> &
    ConnectorAuthMethodIdsWithoutTokenRevoke<Type>,
>(
  type: Type,
  authMethod: Method,
  provider: AuthCodeConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
  },
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
    access: provider.access,
  });
}

function authCodeTokenRevokeProviderEntry<
  Type extends AuthCodeGrantConnectorType & TokenRevokeConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsWithoutRefreshTokenAccess<Type> &
    ConnectorAuthMethodIdsByRevokeKind<Type, "token-revoke">,
>(
  type: Type,
  authMethod: Method,
  provider: AuthCodeConnectorAuthProvider<Type, Method> & {
    readonly revoke: TokenRevokeProvider<Type, Method>;
  },
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
    revoke: provider.revoke,
  });
}

function authCodeRefreshTokenRevokeProviderEntry<
  Type extends AuthCodeGrantConnectorType &
    RefreshTokenAccessConnectorType &
    TokenRevokeConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token"> &
    ConnectorAuthMethodIdsByRevokeKind<Type, "token-revoke">,
>(
  type: Type,
  authMethod: Method,
  provider: AuthCodeConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
    readonly revoke: TokenRevokeProvider<Type, Method>;
  },
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
    access: provider.access,
    revoke: provider.revoke,
  });
}

function deviceAuthProviderEntry<
  Type extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsWithoutRefreshTokenAccess<Type> &
    ConnectorAuthMethodIdsWithoutTokenRevoke<Type>,
>(
  type: Type,
  authMethod: Method,
  provider: DeviceAuthConnectorAuthProvider<Type, Method>,
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
  });
}

function openIdAuthProviderEntry<
  Type extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsWithoutRefreshTokenAccess<Type> &
    ConnectorAuthMethodIdsWithoutTokenRevoke<Type>,
>(
  type: Type,
  authMethod: Method,
  provider: OpenIdAuthConnectorAuthProvider<Type, Method>,
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
  });
}

function deviceAuthRefreshProviderEntry<
  Type extends DeviceAuthGrantConnectorType & RefreshTokenAccessConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token"> &
    ConnectorAuthMethodIdsWithoutTokenRevoke<Type>,
>(
  type: Type,
  authMethod: Method,
  provider: DeviceAuthConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
  },
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
    access: provider.access,
  });
}

function externalCodeRefreshProviderEntry<
  Type extends ExternalCodeGrantConnectorType & RefreshTokenAccessConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token"> &
    ConnectorAuthMethodIdsWithoutTokenRevoke<Type>,
>(
  type: Type,
  authMethod: Method,
  provider: ExternalCodeConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
  },
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
    access: provider.access,
  });
}

function externalCodeRefreshTokenRevokeProviderEntry<
  Type extends ExternalCodeGrantConnectorType &
    RefreshTokenAccessConnectorType &
    TokenRevokeConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token"> &
    ConnectorAuthMethodIdsByRevokeKind<Type, "token-revoke">,
>(
  type: Type,
  authMethod: Method,
  provider: ExternalCodeConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
    readonly revoke: TokenRevokeProvider<Type, Method>;
  },
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    grant: provider.grant,
    access: provider.access,
    revoke: provider.revoke,
  });
}

function refreshProviderEntry<
  Type extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token"> &
    ConnectorAuthMethodIdsWithoutProviderGrant<Type> &
    ConnectorAuthMethodIdsWithoutTokenRevoke<Type>,
>(
  type: Type,
  authMethod: Method,
  provider: {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
  },
): RuntimeAuthProviderRegistration<Type, Method> {
  return connectorAuthProviderRegistryEntry(type, authMethod, {
    access: provider.access,
  });
}

export interface ConnectorAuthProviderMethodSelection {
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}

function assertConnectorAuthProviderMethodContract(
  selection: ConnectorAuthProviderMethodSelection,
  registration: PreparedRuntimeAuthProviderRegistration,
): void {
  if (
    JSON.stringify(connectorAuthProviderMethodContract(selection.method)) !==
    JSON.stringify(registration.capability.contract)
  ) {
    throw new Error(
      `Auth provider contract mismatch for ${selection.connectorRef}:${selection.authMethodId}`,
    );
  }
}

function connectorAuthProviderRegistrationFor(
  selection: ConnectorAuthProviderMethodSelection,
): PreparedRuntimeAuthProviderRegistration {
  const registration = getRuntimeAuthProviderRegistration(
    selection.connectorRef,
    selection.authMethodId,
  );
  assertConnectorAuthProviderMethodContract(selection, registration);
  return registration;
}

function connectorAuthCodeGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeAuthCodeGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "auth-code") {
    throw new Error(
      `Missing auth-code grant provider for ${selection.connectorRef}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorDeviceAuthGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeDeviceAuthGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "device-auth") {
    throw new Error(
      `Missing device-auth grant provider for ${selection.connectorRef}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorOpenIdAuthGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeOpenIdAuthGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "openid-auth") {
    throw new Error(
      `Missing openid-auth grant provider for ${selection.connectorRef}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorExternalCodeGrantProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeExternalCodeGrantProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { grant } = registration.entry;
  if (grant?.kind !== "external-code") {
    throw new Error(
      `Missing external-code grant provider for ${selection.connectorRef}:${selection.authMethodId}`,
    );
  }
  return grant;
}

function connectorRefreshTokenAccessProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeRefreshTokenAccessProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { access } = registration.entry;
  if (access?.kind !== "refresh-token") {
    throw new Error(
      `Missing refresh-token access provider for ${selection.connectorRef}:${selection.authMethodId}`,
    );
  }
  return access;
}

function connectorTokenRevokeProviderFor(
  selection: ConnectorAuthProviderMethodSelection,
): RuntimeTokenRevokeProvider {
  const registration = connectorAuthProviderRegistrationFor(selection);
  const { revoke } = registration.entry;
  if (revoke?.kind !== "token-revoke") {
    throw new Error(
      `Missing token-revoke provider for ${selection.connectorRef}:${selection.authMethodId}`,
    );
  }
  return revoke;
}

function invokeRuntimeProvider<Args, Result>(
  handler: (args: never) => Result,
  args: Args,
): Result {
  // Typed registry builders establish the handler/method relation. Exact
  // runtime contract validation restores it after the open-key lookup.
  return (handler as (input: Args) => Result)(args);
}

function assertConnectorAuthClientMatchesMethod(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly authClient: ConnectorAuthClient;
}): void {
  const client = args.selection.method.client;
  if (client === undefined) {
    throw new Error(
      `Missing auth client configuration for ${args.selection.connectorRef}:${args.selection.authMethodId}`,
    );
  }
  if (
    client.clientRegistration !== args.authClient.clientRegistration ||
    client.clientType !== args.authClient.clientType
  ) {
    throw new Error(
      `Auth client does not match ${args.selection.connectorRef}:${args.selection.authMethodId}`,
    );
  }
  if (
    client.clientRegistration === "static" &&
    "clientId" in client &&
    (args.authClient.clientRegistration !== "static" ||
      client.clientId !== args.authClient.clientId)
  ) {
    throw new Error(
      `Auth client does not match ${args.selection.connectorRef}:${args.selection.authMethodId}`,
    );
  }
  if (
    client.clientRegistration === "static" &&
    client.clientType === "confidential" &&
    "clientSecret" in client &&
    (args.authClient.clientRegistration !== "static" ||
      args.authClient.clientType !== "confidential" ||
      client.clientSecret !== args.authClient.clientSecret)
  ) {
    throw new Error(
      `Auth client does not match ${args.selection.connectorRef}:${args.selection.authMethodId}`,
    );
  }
}

function assertDeclaredProviderOutputs(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly operation: "grant" | "refresh";
  readonly declaredOutputNames: readonly string[];
  readonly outputs: Readonly<Record<string, string | null | undefined>>;
}): void {
  const declaredOutputs = new Set(args.declaredOutputNames);
  for (const outputName of Object.keys(args.outputs)) {
    if (!declaredOutputs.has(outputName)) {
      throw new Error(
        `${args.selection.connectorRef} connector auth method ${args.selection.authMethodId} returned undeclared ${args.operation} output ${outputName}`,
      );
    }
  }
}

function assertDeclaredProviderInputs(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly operation: "refresh" | "revoke";
  readonly declaredInputNames: readonly string[];
  readonly inputs: Readonly<Record<string, string>>;
}): void {
  const declaredInputs = new Set(args.declaredInputNames);
  for (const inputName of Object.keys(args.inputs)) {
    if (!declaredInputs.has(inputName)) {
      throw new Error(
        `${args.selection.connectorRef} connector auth method ${args.selection.authMethodId} received undeclared ${args.operation} input ${inputName}`,
      );
    }
  }
  for (const inputName of declaredInputs) {
    if (!Object.hasOwn(args.inputs, inputName)) {
      throw new Error(
        `${args.selection.connectorRef} connector auth method ${args.selection.authMethodId} is missing ${args.operation} input ${inputName}`,
      );
    }
  }
}

const CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES = [
  authCodeRefreshProviderEntry("ahrefs", "oauth", ahrefsProvider),
  authCodeRefreshProviderEntry("airtable", "oauth", airtableProvider),
  authCodeRefreshProviderEntry("asana", "oauth", asanaProvider),
  externalCodeRefreshProviderEntry("aws", "cli", awsProvider),
  deviceAuthRefreshProviderEntry("base44", "oauth", base44Provider),
  authCodeRefreshProviderEntry("box", "oauth", boxProvider),
  authCodeRefreshProviderEntry("cal-com", "oauth", calComProvider),
  authCodeRefreshProviderEntry("canva", "oauth", canvaProvider),
  authCodeRefreshProviderEntry("close", "oauth", closeProvider),
  authCodeProviderEntry("copper", "oauth", copperProvider),
  authCodeRefreshTokenRevokeProviderEntry(
    "cloudflare",
    "oauth",
    cloudflareProvider,
  ),
  authCodeRefreshProviderEntry("deel", "oauth", deelProvider),
  authCodeRefreshProviderEntry("datadog", "oauth", datadogProvider),
  authCodeRefreshProviderEntry("docusign", "oauth", docusignProvider),
  authCodeRefreshProviderEntry("dropbox", "oauth", dropboxProvider),
  authCodeRefreshProviderEntry("figma", "oauth", figmaProvider),
  authCodeRefreshProviderEntry(
    "garmin-connect",
    "oauth",
    garminConnectProvider,
  ),
  authCodeTokenRevokeProviderEntry("github", "oauth", githubProvider),
  authCodeRefreshProviderEntry("gmail", "oauth", gmailProvider),
  authCodeRefreshProviderEntry("google-ads", "oauth", googleAdsProvider),
  authCodeRefreshProviderEntry(
    "google-analytics",
    "oauth",
    googleAnalyticsProvider,
  ),
  authCodeRefreshProviderEntry(
    "google-calendar",
    "oauth",
    googleCalendarProvider,
  ),
  authCodeRefreshProviderEntry("google-cloud", "oauth", googleCloudProvider),
  authCodeRefreshProviderEntry(
    "google-contacts",
    "oauth",
    googleContactsProvider,
  ),
  authCodeRefreshProviderEntry("google-docs", "oauth", googleDocsProvider),
  authCodeRefreshProviderEntry("google-drive", "oauth", googleDriveProvider),
  authCodeRefreshProviderEntry("google-forms", "oauth", googleFormsProvider),
  authCodeRefreshProviderEntry("google-maps", "oauth", googleMapsProvider),
  authCodeRefreshProviderEntry("google-meet", "oauth", googleMeetProvider),
  authCodeRefreshProviderEntry(
    "google-search-console",
    "oauth",
    googleSearchConsoleProvider,
  ),
  authCodeRefreshProviderEntry("google-sheets", "oauth", googleSheetsProvider),
  authCodeRefreshProviderEntry("gumroad", "oauth", gumroadProvider),
  authCodeRefreshProviderEntry("hubspot", "oauth", hubspotProvider),
  refreshProviderEntry("lark", "api-token", larkProvider),
  authCodeProviderEntry("intervals-icu", "oauth", intervalsIcuProvider),
  authCodeRefreshTokenRevokeProviderEntry("linear", "oauth", linearProvider),
  authCodeProviderEntry("mailchimp", "oauth", mailchimpProvider),
  authCodeRefreshProviderEntry("mercury", "oauth", mercuryProvider),
  authCodeRefreshProviderEntry("microsoft-365", "oauth", microsoft365Provider),
  authCodeRefreshProviderEntry("monday", "oauth", mondayProvider),
  authCodeRefreshProviderEntry("neon", "oauth", neonProvider),
  refreshProviderEntry("netsuite", "api-token", netsuiteProvider),
  externalCodeRefreshProviderEntry(
    "nintendo-store",
    "api",
    nintendoStoreProvider,
  ),
  externalCodeRefreshTokenRevokeProviderEntry(
    "nintendo-switch-parental-controls",
    "api",
    nintendoSwitchParentalControlsProvider,
  ),
  authCodeRefreshProviderEntry("notion", "oauth", notionProvider),
  authCodeRefreshProviderEntry(
    "outlook-calendar",
    "oauth",
    outlookCalendarProvider,
  ),
  authCodeRefreshProviderEntry("outlook-mail", "oauth", outlookMailProvider),
  authCodeRefreshProviderEntry("posthog", "oauth", posthogProvider),
  refreshProviderEntry("paypal", "api-token", paypalProvider),
  externalCodeRefreshProviderEntry("playstation", "api", playstationProvider),
  authCodeRefreshProviderEntry("quickbooks", "oauth", quickbooksProvider),
  refreshProviderEntry("ramp", "api-token", rampProvider),
  authCodeRefreshProviderEntry("reddit", "oauth", redditProvider),
  authCodeRefreshProviderEntry("sentry", "oauth", sentryProvider),
  authCodeTokenRevokeProviderEntry("slack", "oauth", slackProvider),
  deviceAuthRefreshProviderEntry("slock", "oauth", slockProvider),
  authCodeRefreshProviderEntry("spotify", "oauth", spotifyProvider),
  openIdAuthProviderEntry("steam", "openid", steamProvider),
  authCodeRefreshProviderEntry("strava", "oauth", stravaProvider),
  authCodeRefreshProviderEntry("stripe", "oauth", stripeProvider),
  deviceAuthProviderEntry("stripe", "cli", stripeCliProvider),
  authCodeRefreshProviderEntry("supabase", "oauth", supabaseProvider),
  authCodeRefreshProviderEntry("test-oauth", "oauth", testOauthProvider),
  refreshProviderEntry("test-oauth", "api-token", testOauthApiTokenProvider),
  authCodeRefreshProviderEntry("test-oauth", "api", testOauthApiProvider),
  deviceAuthProviderEntry(
    "test-oauth-device",
    "oauth",
    testOauthDeviceProvider,
  ),
  deviceAuthProviderEntry(
    "test-oauth-device",
    "api",
    testOauthDeviceApiProvider,
  ),
  authCodeProviderEntry("todoist", "oauth", todoistProvider),
  authCodeProviderEntry("vercel", "oauth", vercelProvider),
  authCodeProviderEntry("webflow", "oauth", webflowProvider),
  authCodeRefreshProviderEntry("meta-ads", "oauth", metaAdsProvider),
  authCodeRefreshProviderEntry("tiktok-ads", "oauth", tiktokAdsProvider),
  authCodeRefreshProviderEntry("x", "oauth", xProvider),
  authCodeRefreshProviderEntry("xero", "oauth", xeroProvider),
  authCodeRefreshTokenRevokeProviderEntry("youtube", "oauth", youtubeProvider),
  authCodeRefreshProviderEntry("zoom", "oauth", zoomProvider),
  refreshProviderEntry("workday", "api-token", workdayProvider),
];

const CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY = buildRuntimeProviderRegistry(
  CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES,
);

export function getConnectorAuthProviderRegistryCapabilities(): ConnectorAuthProviderRegistryCapabilities {
  const capabilities: MutableConnectorAuthProviderRegistryCapabilities = {};
  for (const registration of CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES) {
    const methodCapabilities = capabilities[registration.type] ?? {};
    methodCapabilities[registration.authMethod] =
      connectorAuthProviderRegistryCapability(registration.entry);
    capabilities[registration.type] = methodCapabilities;
  }
  return capabilities;
}

export function getConnectorAuthProviderRegistrationCapabilities(): readonly ConnectorAuthProviderRegistrationCapability[] {
  return CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES.map((registration) => {
    return structuredClone(
      getRuntimeAuthProviderRegistration(
        registration.type,
        registration.authMethod,
      ).capability,
    );
  }).sort((left, right) => {
    return (
      compareCapabilityStrings(left.connectorRef, right.connectorRef) ||
      compareCapabilityStrings(left.authMethodId, right.authMethodId)
    );
  });
}

type ConnectorAuthCodeResolvedMethodClient =
  ConnectorResolvedAuthMethodClientByGrantKind<"auth-code">;

type ConnectorDeviceAuthResolvedMethodClient =
  ConnectorResolvedAuthMethodClientByGrantKind<"device-auth">;

type ConnectorExternalCodeResolvedMethodClient =
  ConnectorResolvedAuthMethodClientByGrantKind<"external-code">;

type ConnectorAuthCodeAuthorizationUrlArgs =
  ConnectorAuthCodeResolvedMethodClient & {
    readonly redirectUri: string;
    readonly state: string;
  };

type ConnectorOpenIdAuthAuthorizationUrlArgs = {
  readonly [Type in OpenIdAuthGrantConnectorType]: {
    readonly [Method in ConnectorOpenIdAuthGrantAuthMethodId<Type>]: {
      readonly type: Type;
      readonly authMethod: Method;
      readonly returnTo: string;
      readonly realm: string;
      readonly state: string;
    };
  }[ConnectorOpenIdAuthGrantAuthMethodId<Type>];
}[OpenIdAuthGrantConnectorType];

type ConnectorAuthCodeExchangeCallArgs =
  ConnectorAuthCodeResolvedMethodClient & {
    readonly code: string;
    readonly redirectUri: string;
    readonly state: string | undefined;
    readonly codeVerifier: string | undefined;
    readonly oauthContext: string | undefined;
  };

type ConnectorOpenIdAuthVerifyCallArgs = {
  readonly [Type in OpenIdAuthGrantConnectorType]: {
    readonly [Method in ConnectorOpenIdAuthGrantAuthMethodId<Type>]: {
      readonly type: Type;
      readonly authMethod: Method;
      readonly callbackParams: Readonly<Record<string, string>>;
      readonly expectedReturnTo: string;
      readonly expectedRealm: string;
      readonly signal: AbortSignal;
    };
  }[ConnectorOpenIdAuthGrantAuthMethodId<Type>];
}[OpenIdAuthGrantConnectorType];

type ConnectorDeviceAuthorizationStartCallArgs =
  ConnectorDeviceAuthResolvedMethodClient & {
    readonly options: ConnectorDeviceAuthStartOptions;
  };

type ConnectorDeviceAuthorizationPollCallArgs =
  ConnectorDeviceAuthResolvedMethodClient & {
    readonly deviceCode: string;
    readonly pollState?: string;
  };

type ConnectorExternalCodeAuthorizationStartCallArgs =
  ConnectorExternalCodeResolvedMethodClient;

type ConnectorExternalCodeAuthorizationCompleteCallArgs =
  ConnectorExternalCodeResolvedMethodClient & {
    readonly code: string;
    readonly providerState: string;
    readonly signal: AbortSignal;
  };

type ConnectorRefreshTokenAccessCallArgs<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
  Inputs extends Readonly<Record<string, string>> = ConnectorRefreshInputValues<
    T,
    Method
  >,
> =
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">
    ? {
        readonly type: T;
        readonly authMethod: Method;
        readonly inputs: Inputs;
        readonly signal: AbortSignal;
      } & ConnectorRefreshTokenAccessClientArgs<T, Method>
    : never;

type ConnectorRefreshTokenAccessClientArgs<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> =
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">
    ? Omit<ConnectorAuthProviderRefreshArgs<T, Method>, "inputs" | "signal">
    : never;

type ConnectorRefreshTokenAccessDynamicCallArgs = {
  readonly [Type in RefreshTokenAccessConnectorType]: {
    readonly [Method in ConnectorAuthMethodIdsByAccessKind<
      Type,
      "refresh-token"
    >]: ConnectorRefreshTokenAccessCallArgs<
      Type,
      Method,
      Readonly<Record<string, string>>
    >;
  }[ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token">];
}[RefreshTokenAccessConnectorType];

interface RuntimeAuthCodeAuthorizeArgs {
  readonly authClient: ConnectorAuthClientIdentity;
  readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  readonly redirectUri: string;
  readonly state: string;
}

interface RuntimeAuthCodeExchangeArgs {
  readonly authClient: ConnectorAuthClient;
  readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}

interface RuntimeOpenIdAuthorizeArgs {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
  readonly returnTo: string;
  readonly realm: string;
  readonly state: string;
}

interface RuntimeOpenIdVerifyArgs {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
  readonly signal: AbortSignal;
}

interface RuntimeExternalCodeStartArgs {
  readonly authClient: ConnectorAuthClientIdentity;
  readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
}

interface RuntimeExternalCodeCompleteArgs {
  readonly authClient: ConnectorAuthClient;
  readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
  readonly code: string;
  readonly providerState: string;
  readonly signal: AbortSignal;
}

interface RuntimeDeviceAuthorizationStartArgs {
  readonly authClient: ConnectorAuthClientIdentity;
  readonly scopes: readonly string[];
  readonly options: ConnectorDeviceAuthStartOptions;
}

interface RuntimeDeviceAuthorizationPollArgs {
  readonly authClient: ConnectorAuthClient;
  readonly deviceCode: string;
  readonly pollState?: string;
}

interface RuntimeRefreshTokenAccessArgs {
  readonly authClient?: ConnectorAuthClient;
  readonly inputs: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

interface RuntimeTokenRevokeArgs {
  readonly authClient: StaticConnectorAuthClient;
  readonly inputs: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

function getStaticConnectorAuthProviderMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodRuntimeConfig {
  const method = getConnectorAuthMethod(type, authMethod);
  if (method === undefined) {
    throw new Error(
      `Missing auth method configuration for ${type}:${authMethod}`,
    );
  }
  return method;
}

function assertGrantOutputs(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly result: ConnectorAuthProviderGrantResult;
}): void {
  const { grant } = args.selection.method;
  if (
    grant.kind !== "auth-code" &&
    grant.kind !== "openid-auth" &&
    grant.kind !== "external-code" &&
    grant.kind !== "device-auth"
  ) {
    throw new Error(
      `Provider-backed grant required for ${args.selection.connectorRef}:${args.selection.authMethodId}`,
    );
  }
  assertDeclaredProviderOutputs({
    selection: args.selection,
    operation: "grant",
    declaredOutputNames: Object.keys(grant.outputs),
    outputs: args.result.outputs,
  });
}

function assertOptionalConnectorAuthClientMatchesMethod(args: {
  readonly selection: ConnectorAuthProviderMethodSelection;
  readonly authClient: ConnectorAuthClient | undefined;
}): void {
  if (args.selection.method.client === undefined) {
    if (args.authClient !== undefined) {
      throw new Error(
        `Unexpected auth client for ${args.selection.connectorRef}:${args.selection.authMethodId}`,
      );
    }
    return;
  }
  if (args.authClient === undefined) {
    throw new Error(
      `Missing auth client for ${args.selection.connectorRef}:${args.selection.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args.selection,
    authClient: args.authClient,
  });
}

export async function buildConnectorAuthCodeAuthorizationUrlWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly redirectUri: string;
    readonly state: string;
  },
): Promise<string | AuthUrlResult> {
  const provider = connectorAuthCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "auth-code") {
    throw new Error(
      `Auth-code grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  return await invokeRuntimeProvider<
    RuntimeAuthCodeAuthorizeArgs,
    string | AuthUrlResult | Promise<string | AuthUrlResult>
  >(provider.buildAuthUrl, {
    authClient: connectorAuthClientIdentity(args.authClient),
    authCodeGrant: args.method.grant,
    redirectUri: args.redirectUri,
    state: args.state,
  });
}

export async function buildConnectorOpenIdAuthAuthorizationUrlWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly returnTo: string;
    readonly realm: string;
    readonly state: string;
  },
): Promise<string | AuthUrlResult> {
  const provider = connectorOpenIdAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "openid-auth") {
    throw new Error(
      `OpenID grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  return await invokeRuntimeProvider<
    RuntimeOpenIdAuthorizeArgs,
    string | AuthUrlResult | Promise<string | AuthUrlResult>
  >(provider.buildAuthUrl, {
    openIdAuthGrant: args.method.grant,
    returnTo: args.returnTo,
    realm: args.realm,
    state: args.state,
  });
}

export async function exchangeConnectorAuthCodeWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly code: string;
    readonly redirectUri: string;
    readonly state: string | undefined;
    readonly codeVerifier: string | undefined;
    readonly oauthContext: string | undefined;
  },
): Promise<ConnectorAuthProviderGrantResult> {
  const provider = connectorAuthCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "auth-code") {
    throw new Error(
      `Auth-code grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const result = await invokeRuntimeProvider<
    RuntimeAuthCodeExchangeArgs,
    Promise<ConnectorAuthProviderGrantResult>
  >(provider.exchangeCode, {
    authClient: args.authClient,
    authCodeGrant: args.method.grant,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
  assertGrantOutputs({ selection: args, result });
  return result;
}

export async function verifyConnectorOpenIdAuthCallbackWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly callbackParams: Readonly<Record<string, string>>;
    readonly expectedReturnTo: string;
    readonly expectedRealm: string;
    readonly signal: AbortSignal;
  },
): Promise<ConnectorAuthProviderGrantResult> {
  const provider = connectorOpenIdAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "openid-auth") {
    throw new Error(
      `OpenID grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  const result = await invokeRuntimeProvider<
    RuntimeOpenIdVerifyArgs,
    Promise<ConnectorAuthProviderGrantResult>
  >(provider.verifyCallback, {
    openIdAuthGrant: args.method.grant,
    callbackParams: args.callbackParams,
    expectedReturnTo: args.expectedReturnTo,
    expectedRealm: args.expectedRealm,
    signal: args.signal,
  });
  assertGrantOutputs({ selection: args, result });
  return result;
}

export async function startConnectorExternalCodeAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
  },
): Promise<ExternalCodeAuthorizationStartResult> {
  const provider = connectorExternalCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "external-code") {
    throw new Error(
      `External-code grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  return await invokeRuntimeProvider<
    RuntimeExternalCodeStartArgs,
    Promise<ExternalCodeAuthorizationStartResult>
  >(provider.startExternalCodeAuthorization, {
    authClient: connectorAuthClientIdentity(args.authClient),
    externalCodeGrant: args.method.grant,
  });
}

export async function completeConnectorExternalCodeAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly code: string;
    readonly providerState: string;
    readonly signal: AbortSignal;
  },
): Promise<ConnectorAuthProviderGrantResult> {
  const provider = connectorExternalCodeGrantProviderFor(args);
  if (args.method.grant.kind !== "external-code") {
    throw new Error(
      `External-code grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const result = await invokeRuntimeProvider<
    RuntimeExternalCodeCompleteArgs,
    Promise<ConnectorAuthProviderGrantResult>
  >(provider.completeExternalCodeAuthorization, {
    authClient: args.authClient,
    externalCodeGrant: args.method.grant,
    code: args.code,
    providerState: args.providerState,
    signal: args.signal,
  });
  assertGrantOutputs({ selection: args, result });
  return result;
}

export async function startConnectorDeviceAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly options: ConnectorDeviceAuthStartOptions;
  },
): Promise<OAuthDeviceAuthStartResult> {
  const provider = connectorDeviceAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "device-auth") {
    throw new Error(
      `Device-auth grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const startOptionsResult = parseConnectorDeviceAuthStartOptionsConfig({
    connectorRef: args.connectorRef,
    authMethodId: args.authMethodId,
    startOptions: args.method.grant.startOptions,
    options: args.options,
  });
  if (!startOptionsResult.success) {
    throw new Error(startOptionsResult.message);
  }
  return await invokeRuntimeProvider<
    RuntimeDeviceAuthorizationStartArgs,
    Promise<OAuthDeviceAuthStartResult>
  >(provider.startDeviceAuth, {
    authClient: connectorAuthClientIdentity(args.authClient),
    scopes: connectorGrantScopes(args.method.grant),
    options: startOptionsResult.options,
  });
}

export async function pollConnectorDeviceAuthorizationWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient: ConnectorAuthClient;
    readonly deviceCode: string;
    readonly pollState?: string;
  },
): Promise<OAuthDeviceAuthPollResultBase> {
  const provider = connectorDeviceAuthGrantProviderFor(args);
  if (args.method.grant.kind !== "device-auth") {
    throw new Error(
      `Device-auth grant required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  assertConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  const result = await invokeRuntimeProvider<
    RuntimeDeviceAuthorizationPollArgs,
    Promise<OAuthDeviceAuthPollResultBase>
  >(provider.pollDeviceAuth, {
    authClient: args.authClient,
    deviceCode: args.deviceCode,
    ...(args.pollState === undefined ? {} : { pollState: args.pollState }),
  });
  if (result.status === "complete") {
    assertGrantOutputs({ selection: args, result: result.token });
  }
  return result;
}

export async function refreshConnectorAuthProviderAccessTokenWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly authClient?: ConnectorAuthClient;
    readonly inputs: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
): Promise<ConnectorAuthProviderRefreshResultBase> {
  const access = connectorRefreshTokenAccessProviderFor(args);
  const accessMetadata = connectorAuthMethodAccessMetadata(args.method);
  if (accessMetadata.kind !== "refresh-token") {
    throw new Error(
      `Refresh-token access required for ${args.connectorRef}:${args.authMethodId}`,
    );
  }
  assertOptionalConnectorAuthClientMatchesMethod({
    selection: args,
    authClient: args.authClient,
  });
  assertDeclaredProviderInputs({
    selection: args,
    operation: "refresh",
    declaredInputNames: Object.keys(accessMetadata.inputs),
    inputs: args.inputs,
  });
  const result = await invokeRuntimeProvider<
    RuntimeRefreshTokenAccessArgs,
    Promise<ConnectorAuthProviderRefreshResultBase>
  >(access.refresh, {
    ...(args.authClient === undefined ? {} : { authClient: args.authClient }),
    inputs: args.inputs,
    signal: args.signal,
  });
  assertDeclaredProviderOutputs({
    selection: args,
    operation: "refresh",
    declaredOutputNames: Object.keys(accessMetadata.outputs),
    outputs: result.outputs,
  });
  return result;
}

export async function revokeConnectorAuthMethodAccessTokenWithMethod(
  args: ConnectorAuthProviderMethodSelection & {
    readonly readEnv: ConnectorEnvReader;
    readonly signal: AbortSignal;
    readonly loadInputs: () =>
      | Readonly<Record<string, string>>
      | Promise<Readonly<Record<string, string>>>;
  },
): Promise<ConnectorAuthProviderAccessTokenRevokeResult> {
  if (args.method.revoke.kind !== "token-revoke") {
    return { status: "unsupported" };
  }
  const revoke = connectorTokenRevokeProviderFor(args);
  const clientConfig = args.method.client;
  if (clientConfig === undefined) {
    return { status: "unsupported" };
  }
  const authClient = resolveConnectorAuthClient(clientConfig, args.readEnv);
  if (!authClient || !isStaticConnectorAuthClient(authClient)) {
    return { status: "unsupported" };
  }
  const inputs = await args.loadInputs();
  assertDeclaredProviderInputs({
    selection: args,
    operation: "revoke",
    declaredInputNames: Object.keys(args.method.revoke.inputs),
    inputs,
  });
  await invokeRuntimeProvider<RuntimeTokenRevokeArgs, Promise<void>>(
    revoke.revokeToken,
    { authClient, inputs, signal: args.signal },
  );
  return { status: "revoked" };
}

export function buildConnectorAuthCodeAuthorizationUrl<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<string | AuthUrlResult>;
export function buildConnectorAuthCodeAuthorizationUrl(
  args: ConnectorAuthCodeAuthorizationUrlArgs,
): Promise<string | AuthUrlResult>;
export async function buildConnectorAuthCodeAuthorizationUrl<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<string | AuthUrlResult> {
  return await buildConnectorAuthCodeAuthorizationUrlWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    authClient: args.authClient,
    redirectUri: args.redirectUri,
    state: args.state,
  });
}

export function buildConnectorOpenIdAuthAuthorizationUrl<
  T extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly returnTo: string;
  readonly realm: string;
  readonly state: string;
}): Promise<string | AuthUrlResult>;
export function buildConnectorOpenIdAuthAuthorizationUrl(
  args: ConnectorOpenIdAuthAuthorizationUrlArgs,
): Promise<string | AuthUrlResult>;
export async function buildConnectorOpenIdAuthAuthorizationUrl<
  T extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly returnTo: string;
  readonly realm: string;
  readonly state: string;
}): Promise<string | AuthUrlResult> {
  return await buildConnectorOpenIdAuthAuthorizationUrlWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    returnTo: args.returnTo,
    realm: args.realm,
    state: args.state,
  });
}

export function exchangeConnectorAuthCode<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<ConnectorAuthProviderGrantResultForMethod<T, Method>>;
export function exchangeConnectorAuthCode(
  args: ConnectorAuthCodeExchangeCallArgs,
): Promise<ConnectorAuthProviderGrantResult>;
export async function exchangeConnectorAuthCode<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<ConnectorAuthProviderGrantResultForMethod<T, Method>> {
  return (await exchangeConnectorAuthCodeWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    authClient: args.authClient,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  })) as ConnectorAuthProviderGrantResultForMethod<T, Method>;
}

export function verifyConnectorOpenIdAuthCallback<
  T extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
  readonly signal: AbortSignal;
}): Promise<ConnectorAuthProviderGrantResultForMethod<T, Method>>;
export function verifyConnectorOpenIdAuthCallback(
  args: ConnectorOpenIdAuthVerifyCallArgs,
): Promise<ConnectorAuthProviderGrantResult>;
export async function verifyConnectorOpenIdAuthCallback<
  T extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
  readonly signal: AbortSignal;
}): Promise<ConnectorAuthProviderGrantResultForMethod<T, Method>> {
  return (await verifyConnectorOpenIdAuthCallbackWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    callbackParams: args.callbackParams,
    expectedReturnTo: args.expectedReturnTo,
    expectedRealm: args.expectedRealm,
    signal: args.signal,
  })) as ConnectorAuthProviderGrantResultForMethod<T, Method>;
}

export function startConnectorExternalCodeAuthorization<
  T extends ExternalCodeGrantConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
}): Promise<ExternalCodeAuthorizationStartResult>;
export function startConnectorExternalCodeAuthorization(
  args: ConnectorExternalCodeAuthorizationStartCallArgs,
): Promise<ExternalCodeAuthorizationStartResult>;
export async function startConnectorExternalCodeAuthorization<
  T extends ExternalCodeGrantConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
}): Promise<ExternalCodeAuthorizationStartResult> {
  return await startConnectorExternalCodeAuthorizationWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    authClient: args.authClient,
  });
}

export function completeConnectorExternalCodeAuthorization<
  T extends ExternalCodeGrantConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly code: string;
  readonly providerState: string;
  readonly signal: AbortSignal;
}): Promise<ConnectorAuthProviderGrantResultForMethod<T, Method>>;
export function completeConnectorExternalCodeAuthorization(
  args: ConnectorExternalCodeAuthorizationCompleteCallArgs,
): Promise<ConnectorAuthProviderGrantResult>;
export async function completeConnectorExternalCodeAuthorization<
  T extends ExternalCodeGrantConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly code: string;
  readonly providerState: string;
  readonly signal: AbortSignal;
}): Promise<ConnectorAuthProviderGrantResultForMethod<T, Method>> {
  return (await completeConnectorExternalCodeAuthorizationWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    authClient: args.authClient,
    code: args.code,
    providerState: args.providerState,
    signal: args.signal,
  })) as ConnectorAuthProviderGrantResultForMethod<T, Method>;
}

export function startConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly options: ConnectorDeviceAuthStartOptions;
}): Promise<OAuthDeviceAuthStartResult>;
export function startConnectorDeviceAuthorization(
  args: ConnectorDeviceAuthorizationStartCallArgs,
): Promise<OAuthDeviceAuthStartResult>;
export async function startConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly options: ConnectorDeviceAuthStartOptions;
}): Promise<OAuthDeviceAuthStartResult> {
  return await startConnectorDeviceAuthorizationWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    authClient: args.authClient,
    options: args.options,
  });
}

export function pollConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly deviceCode: string;
  readonly pollState?: string;
}): Promise<OAuthDeviceAuthPollResult<T, Method>>;
export function pollConnectorDeviceAuthorization(
  args: ConnectorDeviceAuthorizationPollCallArgs,
): Promise<OAuthDeviceAuthPollResultBase>;
export async function pollConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
  readonly deviceCode: string;
  readonly pollState?: string;
}): Promise<OAuthDeviceAuthPollResult<T, Method>> {
  return (await pollConnectorDeviceAuthorizationWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    authClient: args.authClient,
    deviceCode: args.deviceCode,
    ...(args.pollState === undefined ? {} : { pollState: args.pollState }),
  })) as OAuthDeviceAuthPollResult<T, Method>;
}

export function refreshConnectorAuthProviderAccessToken<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
>(
  args: ConnectorRefreshTokenAccessCallArgs<T, Method>,
): Promise<ConnectorAuthProviderRefreshResult<T, Method>>;
export function refreshConnectorAuthProviderAccessToken(
  args: ConnectorRefreshTokenAccessDynamicCallArgs,
): Promise<ConnectorAuthProviderRefreshResultBase>;
export async function refreshConnectorAuthProviderAccessToken(
  args: ConnectorRefreshTokenAccessDynamicCallArgs,
): Promise<ConnectorAuthProviderRefreshResultBase> {
  return await refreshConnectorAuthProviderAccessTokenWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method: getStaticConnectorAuthProviderMethod(args.type, args.authMethod),
    ...("authClient" in args ? { authClient: args.authClient } : {}),
    inputs: args.inputs,
    signal: args.signal,
  });
}

export async function revokeConnectorAuthMethodAccessToken(args: {
  readonly type: ConnectorType;
  readonly authMethod: string;
  readonly readEnv: ConnectorEnvReader;
  readonly signal: AbortSignal;
  readonly loadInputs: () =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
}): Promise<ConnectorAuthProviderAccessTokenRevokeResult> {
  const method = getConnectorAuthMethod(args.type, args.authMethod);
  if (method === undefined) {
    return { status: "unsupported" };
  }
  return await revokeConnectorAuthMethodAccessTokenWithMethod({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    method,
    readEnv: args.readEnv,
    signal: args.signal,
    loadInputs: args.loadInputs,
  });
}
