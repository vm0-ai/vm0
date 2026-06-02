import {
  type ConnectorAuthCodeGrantAuthMethodId,
  type AuthCodeGrantConnectorType,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorType,
  type ConnectorAuthProviderType,
  type ConnectorDeviceAuthGrantAuthMethodId,
  type ConnectorAuthMethodIdsByGrantKind,
  type DeviceAuthGrantConnectorType,
  type ConnectorAuthMethodIdsByAccessKind,
  type ConnectorAuthMethodIdsByRevokeKind,
  type RefreshTokenAccessConnectorType,
  type TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import {
  connectorAuthMethodSupportsTokenRevoke,
  getConnectorAuthMethod,
  getConnectorAuthMethodAuthCodeGrantConfig,
  getConnectorAuthMethodDeviceAuthGrantConfig,
  getConnectorAuthMethodGrantScopes,
  isStaticConfidentialConnectorAuthClient,
  isStaticConnectorAuthClient,
  resolveConnectorAuthClientForMethod,
  type ConnectorAuthClient,
  type ConnectorEnvReader,
} from "@vm0/connectors/connector-utils";
import type {
  AuthCodeConnectorAuthProvider,
  DeviceAuthConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "./types";
import {
  type AuthUrlResult,
  type ConnectorAuthCodeAuthorizeArgs,
  type ConnectorDeviceAuthorizationPollArgs,
  type ConnectorDeviceAuthorizationStartArgs,
  type ConnectorAuthCodeExchangeArgs,
  type ConnectorAuthProviderRefreshArgs,
  type OAuthAuthorizeArgs,
  type OAuthDeviceAuthPollArgs,
  type OAuthDeviceAuthPollResult,
  type OAuthDeviceAuthStartArgs,
  type OAuthDeviceAuthStartResult,
  type OAuthExchangeArgs,
  type OAuthRefreshArgs,
  type OAuthRefreshResult,
  type OAuthTokenResult,
} from "./oauth/types";
import { providerEnvFromObject, type ProviderEnv } from "./provider-env";
import { ahrefsProvider } from "./oauth/providers/ahrefs-provider";
import { airtableProvider } from "./oauth/providers/airtable-provider";
import { asanaProvider } from "./oauth/providers/asana-provider";
import { base44Provider } from "./oauth/providers/base44-provider";
import { canvaProvider } from "./oauth/providers/canva-provider";
import { closeProvider } from "./oauth/providers/close-provider";
import { deelProvider } from "./oauth/providers/deel-provider";
import { docusignProvider } from "./oauth/providers/docusign-provider";
import { dropboxProvider } from "./oauth/providers/dropbox-provider";
import { figmaProvider } from "./oauth/providers/figma-provider";
import { garminConnectProvider } from "./oauth/providers/garmin-connect-provider";
import { gumroadProvider } from "./oauth/providers/gumroad-provider";
import { githubProvider } from "./oauth/providers/github-provider";
import { gmailProvider } from "./oauth/providers/gmail-provider";
import { hubspotProvider } from "./oauth/providers/hubspot-provider";
import { googleAdsProvider } from "./oauth/providers/google-ads-provider";
import { googleCalendarProvider } from "./oauth/providers/google-calendar-provider";
import { googleDocsProvider } from "./oauth/providers/google-docs-provider";
import { googleDriveProvider } from "./oauth/providers/google-drive-provider";
import { googleMeetProvider } from "./oauth/providers/google-meet-provider";
import { googleSheetsProvider } from "./oauth/providers/google-sheets-provider";
import { linearProvider } from "./oauth/providers/linear-provider";
import { mailchimpProvider } from "./oauth/providers/mailchimp-provider";
import { mercuryProvider } from "./oauth/providers/mercury-provider";
import { mondayProvider } from "./oauth/providers/monday-provider";
import { neonProvider } from "./oauth/providers/neon-provider";
import { notionProvider } from "./oauth/providers/notion-provider";
import { outlookCalendarProvider } from "./oauth/providers/outlook-calendar-provider";
import { outlookMailProvider } from "./oauth/providers/outlook-mail-provider";
import { redditProvider } from "./oauth/providers/reddit-provider";
import { intervalsIcuProvider } from "./oauth/providers/intervals-icu-provider";
import { sentryProvider } from "./oauth/providers/sentry-provider";
import { slackProvider } from "./oauth/providers/slack-provider";
import { slockProvider } from "./oauth/providers/slock-provider";
import { stravaProvider } from "./oauth/providers/strava-provider";
import { stripeProvider } from "./oauth/providers/stripe-provider";
import { todoistProvider } from "./oauth/providers/todoist-provider";
import { vercelProvider } from "./oauth/providers/vercel-provider";
import { webflowProvider } from "./oauth/providers/webflow-provider";
import { supabaseProvider } from "./oauth/providers/supabase-provider";
import { metaAdsProvider } from "./oauth/providers/meta-ads-provider";
import { posthogProvider } from "./oauth/providers/posthog-provider";
import { spotifyProvider } from "./oauth/providers/spotify-provider";
import { xProvider } from "./oauth/providers/x-provider";
import { xeroProvider } from "./oauth/providers/xero-provider";
import { zoomProvider } from "./oauth/providers/zoom-provider";
import {
  testOauthApiProvider,
  testOauthProvider,
} from "./oauth/providers/test-oauth-provider";
import { testOauthDeviceProvider } from "./oauth/providers/test-oauth-device-provider";

export type {
  AuthUrlResult,
  OAuthDeviceAuthPollArgs,
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartArgs,
  OAuthDeviceAuthStartResult,
  OAuthAuthorizeArgs,
  OAuthExchangeArgs,
  OAuthRefreshArgs,
  OAuthRefreshResult,
  OAuthTokenResult,
};
export type { ProviderEnv };
export { providerEnvFromObject };

export type ConnectorAuthProviderAccessTokenRevokeResult =
  | { readonly status: "revoked" }
  | { readonly status: "unsupported" };

type ConnectorAuthCodeGrantProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByGrantKind<
    Type,
    "auth-code"
  >]: ConnectorAuthMethodProviderEntry<Type> & {
    readonly grant: ConnectorAuthCodeGrantProvider<
      Type & AuthCodeGrantConnectorType
    >;
  };
};

type ConnectorDeviceAuthGrantProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByGrantKind<
    Type,
    "device-auth"
  >]: ConnectorAuthMethodProviderEntry<Type> & {
    readonly grant: ConnectorDeviceAuthGrantProvider<
      Type & DeviceAuthGrantConnectorType
    >;
  };
};

type ConnectorRefreshTokenAccessProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByAccessKind<
    Type,
    "refresh-token"
  >]: ConnectorAuthMethodProviderEntry<Type> & {
    readonly access: RefreshTokenAccessProvider<
      Type & RefreshTokenAccessConnectorType
    >;
  };
};

type ConnectorTokenRevokeProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByRevokeKind<
    Type,
    "token-revoke"
  >]: ConnectorAuthMethodProviderEntry<Type> & {
    readonly revoke: ConnectorTokenRevokeProvider;
  };
};

export interface ConnectorAuthProviderClientArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

type ConnectorProviderBackedType =
  | ConnectorAuthProviderType
  | RefreshTokenAccessConnectorType
  | TokenRevokeConnectorType;

type ConnectorAuthCodeGrantProvider<Type extends AuthCodeGrantConnectorType> =
  AuthCodeConnectorAuthProvider<Type>["grant"];

type ConnectorDeviceAuthGrantProvider<
  Type extends DeviceAuthGrantConnectorType,
> = DeviceAuthConnectorAuthProvider<Type>["grant"];

type ConnectorAuthMethodGrantProvider<Type extends ConnectorType> =
  | ConnectorAuthCodeGrantProvider<Type & AuthCodeGrantConnectorType>
  | ConnectorDeviceAuthGrantProvider<Type & DeviceAuthGrantConnectorType>;

interface ConnectorTokenRevokeProvider {
  readonly kind: "token-revoke";
  revokeToken(args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly accessToken: string;
  }): Promise<void>;
}

interface ConnectorAuthMethodProviderEntry<Type extends ConnectorType> {
  readonly grant?: ConnectorAuthMethodGrantProvider<Type>;
  readonly access?: RefreshTokenAccessProvider<
    Type & RefreshTokenAccessConnectorType
  >;
  readonly revoke?: ConnectorTokenRevokeProvider;
}

type ConnectorProviderBackedAuthMethodEntries<
  Type extends ConnectorProviderBackedType,
> = ConnectorAuthCodeGrantProviderEntries<Type> &
  ConnectorDeviceAuthGrantProviderEntries<Type> &
  ConnectorRefreshTokenAccessProviderEntries<Type> &
  ConnectorTokenRevokeProviderEntries<Type>;

type ConnectorAuthMethodProviderRegistry = {
  readonly [Type in ConnectorProviderBackedType]: ConnectorProviderBackedAuthMethodEntries<Type>;
};

function authCodeProviderEntry<Type extends AuthCodeGrantConnectorType>(
  provider: AuthCodeConnectorAuthProvider<Type>,
): ConnectorAuthMethodProviderEntry<Type> & {
  readonly grant: ConnectorAuthCodeGrantProvider<Type>;
} {
  return { grant: provider.grant };
}

function authCodeRefreshProviderEntry<
  Type extends AuthCodeGrantConnectorType & RefreshTokenAccessConnectorType,
>(
  provider: AuthCodeConnectorAuthProvider<Type> & {
    readonly access: RefreshTokenAccessProvider<Type>;
  },
): ConnectorAuthMethodProviderEntry<Type> & {
  readonly grant: ConnectorAuthCodeGrantProvider<Type>;
  readonly access: RefreshTokenAccessProvider<Type>;
} {
  return { grant: provider.grant, access: provider.access };
}

function authCodeTokenRevokeProviderEntry<
  Type extends AuthCodeGrantConnectorType & TokenRevokeConnectorType,
>(
  provider: AuthCodeConnectorAuthProvider<Type>,
): ConnectorAuthMethodProviderEntry<Type> & {
  readonly grant: ConnectorAuthCodeGrantProvider<Type>;
  readonly revoke: ConnectorTokenRevokeProvider;
} {
  return { grant: provider.grant, revoke: provider.revoke };
}

function authCodeRefreshTokenRevokeProviderEntry<
  Type extends AuthCodeGrantConnectorType &
    RefreshTokenAccessConnectorType &
    TokenRevokeConnectorType,
>(
  provider: AuthCodeConnectorAuthProvider<Type> & {
    readonly access: RefreshTokenAccessProvider<Type>;
  },
): ConnectorAuthMethodProviderEntry<Type> & {
  readonly grant: ConnectorAuthCodeGrantProvider<Type>;
  readonly access: RefreshTokenAccessProvider<Type>;
  readonly revoke: ConnectorTokenRevokeProvider;
} {
  return {
    grant: provider.grant,
    access: provider.access,
    revoke: provider.revoke,
  };
}

function deviceAuthProviderEntry<Type extends DeviceAuthGrantConnectorType>(
  provider: DeviceAuthConnectorAuthProvider<Type>,
): ConnectorAuthMethodProviderEntry<Type> & {
  readonly grant: ConnectorDeviceAuthGrantProvider<Type>;
} {
  return { grant: provider.grant };
}

function deviceAuthRefreshProviderEntry<
  Type extends DeviceAuthGrantConnectorType & RefreshTokenAccessConnectorType,
>(
  provider: DeviceAuthConnectorAuthProvider<Type> & {
    readonly access: RefreshTokenAccessProvider<Type>;
  },
): ConnectorAuthMethodProviderEntry<Type> & {
  readonly grant: ConnectorDeviceAuthGrantProvider<Type>;
  readonly access: RefreshTokenAccessProvider<Type>;
} {
  return { grant: provider.grant, access: provider.access };
}

function connectorRefreshTokenAccessProviderFor<
  T extends RefreshTokenAccessConnectorType,
>(type: T, authMethod: string): RefreshTokenAccessProvider<T> | undefined {
  const provider = connectorAuthMethodProviderEntryFor(type, authMethod);
  if (provider?.access?.kind === "refresh-token") {
    return provider.access;
  }
  return undefined;
}

function connectorAuthCodeGrantProviderFor<
  T extends AuthCodeGrantConnectorType,
>(
  type: T,
  authMethod: ConnectorAuthCodeGrantAuthMethodId<T>,
): ConnectorAuthCodeGrantProvider<T> {
  return CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type][authMethod].grant;
}

function connectorDeviceAuthGrantProviderFor<
  T extends DeviceAuthGrantConnectorType,
>(
  type: T,
  authMethod: ConnectorDeviceAuthGrantAuthMethodId<T>,
): ConnectorDeviceAuthGrantProvider<T> {
  return CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type][authMethod].grant;
}

function connectorAuthProviderClientArgs(
  authClient: ConnectorAuthClient,
): ConnectorAuthProviderClientArgs {
  if (!isStaticConnectorAuthClient(authClient)) {
    return {};
  }
  if (isStaticConfidentialConnectorAuthClient(authClient)) {
    return {
      clientId: authClient.clientId,
      clientSecret: authClient.clientSecret,
    };
  }
  return { clientId: authClient.clientId };
}

function connectorAuthCodeAuthorizeProviderArgs<
  T extends AuthCodeGrantConnectorType,
>(
  args: OAuthAuthorizeArgs & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  },
): ConnectorAuthCodeAuthorizeArgs<T> {
  // The runtime resolver already chose the client from the selected method's
  // config; TypeScript cannot connect that resolved value back to the
  // method-config conditional credential fields.
  return args as ConnectorAuthCodeAuthorizeArgs<T>;
}

function connectorAuthCodeExchangeProviderArgs<
  T extends AuthCodeGrantConnectorType,
>(
  args: OAuthExchangeArgs & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  },
): ConnectorAuthCodeExchangeArgs<T> {
  // See connectorAuthCodeAuthorizeProviderArgs.
  return args as ConnectorAuthCodeExchangeArgs<T>;
}

function connectorDeviceAuthorizationStartProviderArgs<
  T extends DeviceAuthGrantConnectorType,
>(
  args: OAuthDeviceAuthStartArgs & {
    readonly deviceAuthGrant: ConnectorDeviceAuthGrantConfig;
  },
): ConnectorDeviceAuthorizationStartArgs<T> {
  // See connectorAuthCodeAuthorizeProviderArgs.
  return args as ConnectorDeviceAuthorizationStartArgs<T>;
}

function connectorDeviceAuthorizationPollProviderArgs<
  T extends DeviceAuthGrantConnectorType,
>(
  args: OAuthDeviceAuthPollArgs & {
    readonly deviceAuthGrant: ConnectorDeviceAuthGrantConfig;
  },
): ConnectorDeviceAuthorizationPollArgs<T> {
  // See connectorAuthCodeAuthorizeProviderArgs.
  return args as ConnectorDeviceAuthorizationPollArgs<T>;
}

function connectorRefreshTokenProviderArgs<
  T extends RefreshTokenAccessConnectorType,
>(
  args: OAuthRefreshArgs & {
    readonly tokenUrl: string;
  },
): ConnectorAuthProviderRefreshArgs<T> {
  // See connectorAuthCodeAuthorizeProviderArgs.
  return args as ConnectorAuthProviderRefreshArgs<T>;
}

export function getConnectorAuthProviderClientArgs(
  authClient: ConnectorAuthClient,
): ConnectorAuthProviderClientArgs {
  return connectorAuthProviderClientArgs(authClient);
}

async function revokeTokenRevokeConnectorAccessToken(args: {
  readonly type: TokenRevokeConnectorType;
  readonly authMethod: string;
  readonly readEnv: ConnectorEnvReader;
  readonly loadAccessToken: () => string | Promise<string>;
}): Promise<ConnectorAuthProviderAccessTokenRevokeResult> {
  const revoke = connectorTokenRevokeProviderFor(args.type, args.authMethod);
  if (!revoke) {
    return { status: "unsupported" };
  }

  const authClient = resolveConnectorAuthClientForMethod(
    args.type,
    args.authMethod,
    args.readEnv,
  );
  if (!authClient || !isStaticConfidentialConnectorAuthClient(authClient)) {
    return { status: "unsupported" };
  }

  await revoke.revokeToken({
    clientId: authClient.clientId,
    clientSecret: authClient.clientSecret,
    accessToken: await args.loadAccessToken(),
  });
  return { status: "revoked" };
}

function connectorTokenRevokeProviderFor<T extends TokenRevokeConnectorType>(
  type: T,
  authMethod: string,
): ConnectorTokenRevokeProvider | undefined {
  const provider = connectorAuthMethodProviderEntryFor(type, authMethod);
  if (provider?.revoke?.kind === "token-revoke") {
    return provider.revoke;
  }
  return undefined;
}

const CONNECTOR_AUTH_METHOD_PROVIDERS = {
  ahrefs: { oauth: authCodeRefreshProviderEntry(ahrefsProvider) },
  airtable: { oauth: authCodeRefreshProviderEntry(airtableProvider) },
  asana: { oauth: authCodeRefreshProviderEntry(asanaProvider) },
  base44: { oauth: deviceAuthRefreshProviderEntry(base44Provider) },
  canva: { oauth: authCodeRefreshProviderEntry(canvaProvider) },
  close: { oauth: authCodeRefreshProviderEntry(closeProvider) },
  deel: { oauth: authCodeRefreshProviderEntry(deelProvider) },
  docusign: { oauth: authCodeRefreshProviderEntry(docusignProvider) },
  dropbox: { oauth: authCodeRefreshProviderEntry(dropboxProvider) },
  figma: { oauth: authCodeRefreshProviderEntry(figmaProvider) },
  "garmin-connect": {
    oauth: authCodeRefreshProviderEntry(garminConnectProvider),
  },
  github: { oauth: authCodeTokenRevokeProviderEntry(githubProvider) },
  gmail: { oauth: authCodeRefreshProviderEntry(gmailProvider) },
  "google-ads": { oauth: authCodeRefreshProviderEntry(googleAdsProvider) },
  "google-calendar": {
    oauth: authCodeRefreshProviderEntry(googleCalendarProvider),
  },
  "google-docs": {
    oauth: authCodeRefreshProviderEntry(googleDocsProvider),
  },
  "google-drive": {
    oauth: authCodeRefreshProviderEntry(googleDriveProvider),
  },
  "google-meet": {
    oauth: authCodeRefreshProviderEntry(googleMeetProvider),
  },
  "google-sheets": {
    oauth: authCodeRefreshProviderEntry(googleSheetsProvider),
  },
  gumroad: { oauth: authCodeRefreshProviderEntry(gumroadProvider) },
  hubspot: { oauth: authCodeRefreshProviderEntry(hubspotProvider) },
  "intervals-icu": {
    oauth: authCodeProviderEntry(intervalsIcuProvider),
  },
  linear: { oauth: authCodeRefreshTokenRevokeProviderEntry(linearProvider) },
  mailchimp: { oauth: authCodeProviderEntry(mailchimpProvider) },
  mercury: { oauth: authCodeRefreshProviderEntry(mercuryProvider) },
  monday: { oauth: authCodeRefreshProviderEntry(mondayProvider) },
  neon: { oauth: authCodeRefreshProviderEntry(neonProvider) },
  notion: { oauth: authCodeRefreshProviderEntry(notionProvider) },
  "outlook-calendar": {
    oauth: authCodeRefreshProviderEntry(outlookCalendarProvider),
  },
  "outlook-mail": {
    oauth: authCodeRefreshProviderEntry(outlookMailProvider),
  },
  posthog: { oauth: authCodeRefreshProviderEntry(posthogProvider) },
  reddit: { oauth: authCodeRefreshProviderEntry(redditProvider) },
  sentry: { oauth: authCodeRefreshProviderEntry(sentryProvider) },
  slack: { oauth: authCodeTokenRevokeProviderEntry(slackProvider) },
  slock: { oauth: deviceAuthRefreshProviderEntry(slockProvider) },
  spotify: { oauth: authCodeRefreshProviderEntry(spotifyProvider) },
  strava: { oauth: authCodeRefreshProviderEntry(stravaProvider) },
  stripe: { oauth: authCodeRefreshProviderEntry(stripeProvider) },
  supabase: { oauth: authCodeRefreshProviderEntry(supabaseProvider) },
  "test-oauth": {
    oauth: authCodeRefreshProviderEntry(testOauthProvider),
    api: authCodeRefreshProviderEntry(testOauthApiProvider),
  },
  "test-oauth-device": {
    oauth: deviceAuthProviderEntry(testOauthDeviceProvider),
  },
  todoist: { oauth: authCodeProviderEntry(todoistProvider) },
  vercel: { oauth: authCodeProviderEntry(vercelProvider) },
  webflow: { oauth: authCodeProviderEntry(webflowProvider) },
  "meta-ads": { oauth: authCodeProviderEntry(metaAdsProvider) },
  x: { oauth: authCodeRefreshProviderEntry(xProvider) },
  xero: { oauth: authCodeRefreshProviderEntry(xeroProvider) },
  zoom: { oauth: authCodeRefreshProviderEntry(zoomProvider) },
} satisfies ConnectorAuthMethodProviderRegistry;

const CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY: ConnectorAuthMethodProviderRegistry =
  CONNECTOR_AUTH_METHOD_PROVIDERS;

function connectorAuthMethodProviderEntryFor<
  Type extends ConnectorProviderBackedType,
>(
  type: Type,
  authMethod: string,
): ConnectorAuthMethodProviderEntry<Type> | undefined {
  const providers: Readonly<
    Record<string, ConnectorAuthMethodProviderEntry<Type>>
  > = CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type];
  return providers[authMethod];
}

export async function buildConnectorAuthCodeAuthorizationUrl<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClient;
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
  return await provider.buildAuthUrl(
    connectorAuthCodeAuthorizeProviderArgs<T>({
      ...connectorAuthProviderClientArgs(args.authClient),
      authCodeGrant,
      redirectUri: args.redirectUri,
      state: args.state,
    }),
  );
}

export async function exchangeConnectorAuthCode<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClient;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<OAuthTokenResult> {
  const provider = connectorAuthCodeGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const authCodeGrant = getConnectorAuthMethodAuthCodeGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.exchangeCode(
    connectorAuthCodeExchangeProviderArgs<T>({
      ...connectorAuthProviderClientArgs(args.authClient),
      authCodeGrant,
      code: args.code,
      redirectUri: args.redirectUri,
      state: args.state,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    }),
  );
}

export async function startConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClient;
}): Promise<OAuthDeviceAuthStartResult> {
  const provider = connectorDeviceAuthGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const deviceAuthGrant = getConnectorAuthMethodDeviceAuthGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.startDeviceAuth(
    connectorDeviceAuthorizationStartProviderArgs<T>({
      ...connectorAuthProviderClientArgs(args.authClient),
      deviceAuthGrant,
      scopes: getConnectorAuthMethodGrantScopes(args.type, args.authMethod),
    }),
  );
}

export async function pollConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClient;
  readonly deviceCode: string;
}): Promise<OAuthDeviceAuthPollResult> {
  const provider = connectorDeviceAuthGrantProviderFor(
    args.type,
    args.authMethod,
  );
  const deviceAuthGrant = getConnectorAuthMethodDeviceAuthGrantConfig(
    args.type,
    args.authMethod,
  );
  return await provider.pollDeviceAuth(
    connectorDeviceAuthorizationPollProviderArgs<T>({
      ...connectorAuthProviderClientArgs(args.authClient),
      deviceAuthGrant,
      deviceCode: args.deviceCode,
    }),
  );
}

export async function refreshConnectorAuthProviderAccessToken<
  T extends RefreshTokenAccessConnectorType,
>(args: {
  readonly type: T;
  readonly authMethod: string;
  readonly clientArgs: ConnectorAuthProviderClientArgs;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
}): Promise<OAuthRefreshResult> {
  const method = getConnectorAuthMethod(args.type, args.authMethod);
  if (method?.access.kind !== "refresh-token") {
    throw new Error(
      `${args.type} connector auth method ${args.authMethod} does not support token refresh`,
    );
  }
  const access = connectorRefreshTokenAccessProviderFor(
    args.type,
    args.authMethod,
  );
  if (!access) {
    throw new Error(
      `${args.type} connector auth method ${args.authMethod} has no refresh-token access provider`,
    );
  }
  return await access.refreshToken(
    connectorRefreshTokenProviderArgs<T>({
      ...args.clientArgs,
      tokenUrl: method.access.tokenUrl,
      refreshToken: args.refreshToken,
      signal: args.signal,
    }),
  );
}

export async function revokeConnectorAuthMethodAccessToken<
  T extends ConnectorType,
>(args: {
  readonly type: T;
  readonly authMethod: string;
  readonly readEnv: ConnectorEnvReader;
  readonly loadAccessToken: () => string | Promise<string>;
}): Promise<ConnectorAuthProviderAccessTokenRevokeResult> {
  if (!connectorAuthMethodSupportsTokenRevoke(args.type, args.authMethod)) {
    return { status: "unsupported" };
  }

  return await revokeTokenRevokeConnectorAccessToken({
    type: args.type,
    authMethod: args.authMethod,
    readEnv: args.readEnv,
    loadAccessToken: args.loadAccessToken,
  });
}
