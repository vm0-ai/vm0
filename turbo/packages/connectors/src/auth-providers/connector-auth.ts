import {
  type ConnectorAuthCodeGrantAuthMethodId,
  type AuthCodeGrantConnectorType,
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
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
  type ConnectorRefreshInputValues,
  type ConnectorRevokeInputValues,
  type RefreshTokenAccessConnectorType,
  type TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import {
  connectorAuthClientIdentityForMethod,
  connectorAuthMethodRefHasRevokeKind,
  getConnectorAuthMethodAccessMetadata,
  getConnectorAuthMethodAuthCodeGrantConfig,
  getConnectorAuthMethodOpenIdAuthGrantConfig,
  getConnectorAuthMethodExternalCodeGrantConfig,
  getConnectorAuthMethodGrantScopes,
  isStaticConnectorAuthClient,
  parseConnectorDeviceAuthStartOptions,
  resolveConnectorAuthClientForMethod,
  type ConnectorAuthClientForMethod,
  type ConnectorResolvedAuthMethodClientByGrantKind,
  type ConnectorEnvReader,
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
import { canvaProvider } from "./connectors/canva/provider";
import { closeProvider } from "./connectors/close/provider";
import { cloudflareProvider } from "./connectors/cloudflare/provider";
import { deelProvider } from "./connectors/deel/provider";
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
import { quickbooksProvider } from "./connectors/quickbooks/provider";
import { playstationProvider } from "./connectors/playstation/provider";
import { spotifyProvider } from "./connectors/spotify/provider";
import { steamProvider } from "./connectors/steam/provider";
import { tiktokAdsProvider } from "./connectors/tiktok-ads/provider";
import { xProvider } from "./connectors/x/provider";
import { xeroProvider } from "./connectors/xero/provider";
import { youtubeProvider } from "./connectors/youtube/provider";
import { zoomProvider } from "./connectors/zoom/provider";
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

type ConnectorAuthCodeGrantProvider<
  Type extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> =
    ConnectorAuthCodeGrantAuthMethodId<Type>,
> = AuthCodeConnectorAuthProvider<Type, Method>["grant"];

type ConnectorDeviceAuthGrantProvider<
  Type extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<Type> =
    ConnectorDeviceAuthGrantAuthMethodId<Type>,
> = DeviceAuthConnectorAuthProvider<Type, Method>["grant"];

type ConnectorOpenIdAuthGrantProvider<
  Type extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<Type> =
    ConnectorOpenIdAuthGrantAuthMethodId<Type>,
> = OpenIdAuthConnectorAuthProvider<Type, Method>["grant"];

type ConnectorExternalCodeGrantProvider<
  Type extends ExternalCodeGrantConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<Type> =
    ConnectorExternalCodeGrantAuthMethodId<Type>,
> = ExternalCodeConnectorAuthProvider<Type, Method>["grant"];

type ConnectorAuthMethodIdsWithoutProviderGrant<Type extends ConnectorType> =
  Exclude<
    ConnectorAuthMethodId,
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
  ConnectorAuthMethodId,
  ConnectorAuthMethodIdsByAccessKind<
    Type & RefreshTokenAccessConnectorType,
    "refresh-token"
  >
>;

type ConnectorAuthMethodIdsWithoutTokenRevoke<Type extends ConnectorType> =
  Exclude<
    ConnectorAuthMethodId,
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
  Method extends ConnectorAuthMethodId = ConnectorAuthMethodId,
> = {
  readonly type: Type;
  readonly authMethod: Method;
  readonly entry: RuntimeAuthProviderEntry;
};

type RuntimeAuthProviderRegistry = Readonly<
  Partial<
    Record<
      ConnectorType,
      Readonly<Partial<Record<ConnectorAuthMethodId, RuntimeAuthProviderEntry>>>
    >
  >
>;

type MutableRuntimeAuthProviderRegistry = Partial<
  Record<
    ConnectorType,
    Partial<Record<ConnectorAuthMethodId, RuntimeAuthProviderEntry>>
  >
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
          Record<ConnectorAuthMethodId, ConnectorAuthProviderRegistryCapability>
        >
      >
    >
  >
>;

type MutableConnectorAuthProviderRegistryCapabilities = Partial<
  Record<
    ConnectorType,
    Partial<
      Record<ConnectorAuthMethodId, ConnectorAuthProviderRegistryCapability>
    >
  >
>;

type TokenRevokeAuthMethodRef = {
  readonly type: TokenRevokeConnectorType;
  readonly authMethod: ConnectorAuthMethodIdsByRevokeKind<
    TokenRevokeConnectorType,
    "token-revoke"
  >;
};

function connectorAuthProviderRegistryEntry<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodId,
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
  const registry: MutableRuntimeAuthProviderRegistry = {};
  for (const registration of registrations) {
    const methodEntries = registry[registration.type] ?? {};
    if (methodEntries[registration.authMethod] !== undefined) {
      throw new Error(
        `Duplicate auth provider registration for ${registration.type}:${registration.authMethod}`,
      );
    }
    methodEntries[registration.authMethod] = registration.entry;
    registry[registration.type] = methodEntries;
  }
  return registry;
}

function getRuntimeAuthProviderEntry(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): RuntimeAuthProviderEntry {
  const entry = CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type]?.[authMethod];
  if (entry === undefined) {
    throw new Error(
      `Missing auth provider registration for ${type}:${authMethod}`,
    );
  }
  return entry;
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

function connectorRefreshTokenAccessProviderFor<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
>(type: T, authMethod: Method): RefreshTokenAccessProvider<T, Method> {
  const { access } = getRuntimeAuthProviderEntry(type, authMethod);
  if (access?.kind !== "refresh-token") {
    throw new Error(
      `Missing refresh-token access provider for ${type}:${authMethod}`,
    );
  }
  return access as RefreshTokenAccessProvider<T, Method>;
}

function connectorAuthCodeGrantProviderFor<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(type: T, authMethod: Method): ConnectorAuthCodeGrantProvider<T, Method> {
  const { grant } = getRuntimeAuthProviderEntry(type, authMethod);
  if (grant?.kind !== "auth-code") {
    throw new Error(
      `Missing auth-code grant provider for ${type}:${authMethod}`,
    );
  }
  return grant as ConnectorAuthCodeGrantProvider<T, Method>;
}

function connectorDeviceAuthGrantProviderFor<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(type: T, authMethod: Method): ConnectorDeviceAuthGrantProvider<T, Method> {
  const { grant } = getRuntimeAuthProviderEntry(type, authMethod);
  if (grant?.kind !== "device-auth") {
    throw new Error(
      `Missing device-auth grant provider for ${type}:${authMethod}`,
    );
  }
  return grant as ConnectorDeviceAuthGrantProvider<T, Method>;
}

function connectorOpenIdAuthGrantProviderFor<
  T extends OpenIdAuthGrantConnectorType,
  Method extends ConnectorOpenIdAuthGrantAuthMethodId<T>,
>(type: T, authMethod: Method): ConnectorOpenIdAuthGrantProvider<T, Method> {
  const { grant } = getRuntimeAuthProviderEntry(type, authMethod);
  if (grant?.kind !== "openid-auth") {
    throw new Error(
      `Missing openid-auth grant provider for ${type}:${authMethod}`,
    );
  }
  return grant as ConnectorOpenIdAuthGrantProvider<T, Method>;
}

function connectorExternalCodeGrantProviderFor<
  T extends ExternalCodeGrantConnectorType,
  Method extends ConnectorExternalCodeGrantAuthMethodId<T>,
>(type: T, authMethod: Method): ConnectorExternalCodeGrantProvider<T, Method> {
  const { grant } = getRuntimeAuthProviderEntry(type, authMethod);
  if (grant?.kind !== "external-code") {
    throw new Error(
      `Missing external-code grant provider for ${type}:${authMethod}`,
    );
  }
  return grant as ConnectorExternalCodeGrantProvider<T, Method>;
}

async function revokeTokenRevokeConnectorAccessToken<
  T extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly readEnv: ConnectorEnvReader;
  readonly signal: AbortSignal;
  readonly loadInputs: () =>
    | ConnectorRevokeInputValues<T, Method>
    | Promise<ConnectorRevokeInputValues<T, Method>>;
}): Promise<ConnectorAuthProviderAccessTokenRevokeResult> {
  const revoke = connectorTokenRevokeProviderFor(args.type, args.authMethod);

  const authClient = resolveConnectorAuthClientForMethod(
    args.type,
    args.authMethod,
    args.readEnv,
  );
  if (!authClient || !isStaticConnectorAuthClient(authClient)) {
    return { status: "unsupported" };
  }

  await revoke.revokeToken({
    authClient,
    inputs: await args.loadInputs(),
    signal: args.signal,
  });
  return { status: "revoked" };
}

function connectorTokenRevokeProviderFor<
  T extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
>(type: T, authMethod: Method): TokenRevokeProvider<T, Method> {
  const { revoke } = getRuntimeAuthProviderEntry(type, authMethod);
  if (revoke?.kind !== "token-revoke") {
    throw new Error(`Missing token-revoke provider for ${type}:${authMethod}`);
  }
  return revoke as TokenRevokeProvider<T, Method>;
}

const CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES = [
  authCodeRefreshProviderEntry("ahrefs", "oauth", ahrefsProvider),
  authCodeRefreshProviderEntry("airtable", "oauth", airtableProvider),
  authCodeRefreshProviderEntry("asana", "oauth", asanaProvider),
  externalCodeRefreshProviderEntry("aws", "cli", awsProvider),
  deviceAuthRefreshProviderEntry("base44", "oauth", base44Provider),
  authCodeRefreshProviderEntry("box", "oauth", boxProvider),
  authCodeRefreshProviderEntry("canva", "oauth", canvaProvider),
  authCodeRefreshProviderEntry("close", "oauth", closeProvider),
  authCodeRefreshTokenRevokeProviderEntry(
    "cloudflare",
    "oauth",
    cloudflareProvider,
  ),
  authCodeRefreshProviderEntry("deel", "oauth", deelProvider),
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
  externalCodeRefreshProviderEntry("playstation", "api", playstationProvider),
  authCodeRefreshProviderEntry("quickbooks", "oauth", quickbooksProvider),
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
];

const CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY = buildRuntimeProviderRegistry(
  CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES,
);

export function getConnectorAuthProviderRegistryCapabilities(): ConnectorAuthProviderRegistryCapabilities {
  const capabilities: MutableConnectorAuthProviderRegistryCapabilities = {};
  for (const registration of CONNECTOR_AUTH_METHOD_PROVIDER_ENTRIES) {
    const methodCapabilities = capabilities[registration.type] ?? {};
    methodCapabilities[registration.authMethod] = {
      ...(registration.entry.grant === undefined
        ? {}
        : { grant: registration.entry.grant.kind }),
      ...(registration.entry.access === undefined
        ? {}
        : { access: registration.entry.access.kind }),
      ...(registration.entry.revoke === undefined
        ? {}
        : { revoke: registration.entry.revoke.kind }),
    };
    capabilities[registration.type] = methodCapabilities;
  }
  return capabilities;
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
  const provider = connectorAuthCodeGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const authCodeGrant = getConnectorAuthMethodAuthCodeGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.buildAuthUrl({
    authClient: connectorAuthClientIdentityForMethod(args.authClient),
    authCodeGrant,
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
  const provider = connectorOpenIdAuthGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const openIdAuthGrant = getConnectorAuthMethodOpenIdAuthGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.buildAuthUrl({
    openIdAuthGrant,
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
  const provider = connectorAuthCodeGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const authCodeGrant = getConnectorAuthMethodAuthCodeGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.exchangeCode({
    authClient: args.authClient,
    authCodeGrant,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  });
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
  const provider = connectorOpenIdAuthGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const openIdAuthGrant = getConnectorAuthMethodOpenIdAuthGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.verifyCallback({
    openIdAuthGrant,
    callbackParams: args.callbackParams,
    expectedReturnTo: args.expectedReturnTo,
    expectedRealm: args.expectedRealm,
    signal: args.signal,
  });
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
  const provider = connectorExternalCodeGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const externalCodeGrant = getConnectorAuthMethodExternalCodeGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.startExternalCodeAuthorization({
    authClient: connectorAuthClientIdentityForMethod(args.authClient),
    externalCodeGrant,
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
  const provider = connectorExternalCodeGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const externalCodeGrant = getConnectorAuthMethodExternalCodeGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.completeExternalCodeAuthorization({
    authClient: args.authClient,
    externalCodeGrant,
    code: args.code,
    providerState: args.providerState,
    signal: args.signal,
  });
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
  const provider = connectorDeviceAuthGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const startOptionsResult = parseConnectorDeviceAuthStartOptions({
    type: args.type,
    authMethod: args.authMethod,
    options: args.options,
  });
  if (!startOptionsResult.success) {
    throw new Error(startOptionsResult.message);
  }
  return await provider.startDeviceAuth({
    authClient: connectorAuthClientIdentityForMethod(args.authClient),
    scopes: getConnectorAuthMethodGrantScopes(args.type, args.authMethod),
    options: startOptionsResult.options,
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
  const provider = connectorDeviceAuthGrantProviderFor(
    args.type,
    args.authMethod,
  );
  return await provider.pollDeviceAuth({
    authClient: args.authClient,
    deviceCode: args.deviceCode,
    ...(args.pollState === undefined ? {} : { pollState: args.pollState }),
  });
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
  const accessMetadata = getConnectorAuthMethodAccessMetadata(
    args.type,
    args.authMethod,
  );
  const access = connectorRefreshTokenAccessProviderFor(
    args.type,
    args.authMethod,
  );
  const result = await access.refresh(args);
  const declaredOutputs = new Set(Object.keys(accessMetadata.outputs));
  for (const outputName of Object.keys(result.outputs)) {
    if (!declaredOutputs.has(outputName)) {
      throw new Error(
        `${args.type} connector auth method ${args.authMethod} returned undeclared refresh output ${outputName}`,
      );
    }
  }
  return result;
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
  const parsedAuthMethod = connectorAuthMethodIdSchema.safeParse(
    args.authMethod,
  );
  if (!parsedAuthMethod.success) {
    return { status: "unsupported" };
  }

  const authMethodRef = {
    type: args.type,
    authMethod: parsedAuthMethod.data,
  };
  if (!connectorAuthMethodRefHasRevokeKind(authMethodRef, "token-revoke")) {
    return { status: "unsupported" };
  }
  // The guard above is the runtime source of truth for dynamic revoke refs.
  const tokenRevokeAuthMethodRef = authMethodRef as TokenRevokeAuthMethodRef;

  return await revokeTokenRevokeConnectorAccessToken({
    type: tokenRevokeAuthMethodRef.type,
    authMethod: tokenRevokeAuthMethodRef.authMethod,
    readEnv: args.readEnv,
    signal: args.signal,
    loadInputs: args.loadInputs,
  });
}
