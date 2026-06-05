import {
  type ConnectorAuthCodeGrantAuthMethodId,
  type AuthCodeGrantConnectorType,
  connectorAuthMethodIdSchema,
  type ConnectorType,
  type AuthGrantConnectorType,
  type ConnectorDeviceAuthGrantAuthMethodId,
  type ConnectorDeviceAuthStartOptions,
  type ConnectorAuthMethodIdsByGrantKind,
  type DeviceAuthGrantConnectorType,
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
  getConnectorAuthMethodGrantScopes,
  isStaticConfidentialConnectorAuthClient,
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
  RefreshTokenAccessProvider,
  TokenRevokeProvider,
} from "./types";
import type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantResultForMethod,
} from "./grant-result";
import {
  type AuthUrlResult,
  type OAuthDeviceAuthPollResult,
  type OAuthDeviceAuthPollResultBase,
  type OAuthDeviceAuthStartResult,
} from "./provider-flow-types";
import { providerEnvFromObject, type ProviderEnv } from "./provider-env";
import { ahrefsProvider } from "./connectors/ahrefs/provider";
import { airtableProvider } from "./connectors/airtable/provider";
import { asanaProvider } from "./connectors/asana/provider";
import { base44Provider } from "./connectors/base44/provider";
import { canvaProvider } from "./connectors/canva/provider";
import { closeProvider } from "./connectors/close/provider";
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
import { googleCalendarProvider } from "./connectors/google-calendar/provider";
import { googleDocsProvider } from "./connectors/google-docs/provider";
import { googleDriveProvider } from "./connectors/google-drive/provider";
import { googleMeetProvider } from "./connectors/google-meet/provider";
import { googleSheetsProvider } from "./connectors/google-sheets/provider";
import { larkProvider } from "./connectors/lark/provider";
import { linearProvider } from "./connectors/linear/provider";
import { mailchimpProvider } from "./connectors/mailchimp/provider";
import { mercuryProvider } from "./connectors/mercury/provider";
import { mondayProvider } from "./connectors/monday/provider";
import { neonProvider } from "./connectors/neon/provider";
import { notionProvider } from "./connectors/notion/provider";
import { outlookCalendarProvider } from "./connectors/outlook-calendar/provider";
import { outlookMailProvider } from "./connectors/outlook-mail/provider";
import { redditProvider } from "./connectors/reddit/provider";
import { intervalsIcuProvider } from "./connectors/intervals-icu/provider";
import { sentryProvider } from "./connectors/sentry/provider";
import { slackProvider } from "./connectors/slack/provider";
import { slockProvider } from "./connectors/slock/provider";
import { stravaProvider } from "./connectors/strava/provider";
import { stripeProvider } from "./connectors/stripe/provider";
import { todoistProvider } from "./connectors/todoist/provider";
import { vercelProvider } from "./connectors/vercel/provider";
import { webflowProvider } from "./connectors/webflow/provider";
import { supabaseProvider } from "./connectors/supabase/provider";
import { metaAdsProvider } from "./connectors/meta-ads/provider";
import { posthogProvider } from "./connectors/posthog/provider";
import { spotifyProvider } from "./connectors/spotify/provider";
import { xProvider } from "./connectors/x/provider";
import { xeroProvider } from "./connectors/xero/provider";
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
  ConnectorAuthProviderRefreshResultBase,
  ConnectorAuthProviderRefreshResult,
};
export type { ProviderEnv };
export { providerEnvFromObject };

export type ConnectorAuthProviderAccessTokenRevokeResult =
  | { readonly status: "revoked" }
  | { readonly status: "unsupported" };

type ConnectorProviderBackedType =
  | AuthGrantConnectorType
  | RefreshTokenAccessConnectorType
  | TokenRevokeConnectorType;

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

type ConnectorAuthCodeProviderEntry<
  Type extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type>,
> = {
  readonly grant: ConnectorAuthCodeGrantProvider<Type, Method>;
};

type ConnectorDeviceAuthProviderEntry<
  Type extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<Type>,
> = {
  readonly grant: ConnectorDeviceAuthGrantProvider<Type, Method>;
};

type ConnectorRefreshTokenAccessProviderEntry<
  Type extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token">,
> = {
  readonly access: RefreshTokenAccessProvider<Type, Method>;
};

type ConnectorTokenRevokeProviderEntry<
  Type extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<Type, "token-revoke">,
> = {
  readonly revoke: TokenRevokeProvider<Type, Method>;
};

type ConnectorAuthCodeGrantProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByGrantKind<
    Type,
    "auth-code"
  >]: ConnectorAuthCodeProviderEntry<
    Type & AuthCodeGrantConnectorType,
    Method &
      ConnectorAuthCodeGrantAuthMethodId<Type & AuthCodeGrantConnectorType>
  >;
};

type ConnectorDeviceAuthGrantProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByGrantKind<
    Type,
    "device-auth"
  >]: ConnectorDeviceAuthProviderEntry<
    Type & DeviceAuthGrantConnectorType,
    Method &
      ConnectorDeviceAuthGrantAuthMethodId<Type & DeviceAuthGrantConnectorType>
  >;
};

type ConnectorRefreshTokenAccessProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByAccessKind<
    Type,
    "refresh-token"
  >]: ConnectorRefreshTokenAccessProviderEntry<
    Type & RefreshTokenAccessConnectorType,
    Method &
      ConnectorAuthMethodIdsByAccessKind<
        Type & RefreshTokenAccessConnectorType,
        "refresh-token"
      >
  >;
};

type ConnectorTokenRevokeProviderEntries<Type extends ConnectorType> = {
  readonly [Method in ConnectorAuthMethodIdsByRevokeKind<
    Type,
    "token-revoke"
  >]: ConnectorTokenRevokeProviderEntry<
    Type & TokenRevokeConnectorType,
    Method &
      ConnectorAuthMethodIdsByRevokeKind<
        Type & TokenRevokeConnectorType,
        "token-revoke"
      >
  >;
};

type ConnectorProviderBackedAuthMethodEntries<
  Type extends ConnectorProviderBackedType,
> = ConnectorAuthCodeGrantProviderEntries<Type> &
  ConnectorDeviceAuthGrantProviderEntries<Type> &
  ConnectorRefreshTokenAccessProviderEntries<Type> &
  ConnectorTokenRevokeProviderEntries<Type>;

type ConnectorAuthMethodProviderRegistry = {
  readonly [Type in ConnectorProviderBackedType]: ConnectorProviderBackedAuthMethodEntries<Type>;
};

function authCodeProviderEntry<
  Type extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type>,
>(
  provider: AuthCodeConnectorAuthProvider<Type, Method>,
): ConnectorAuthCodeProviderEntry<Type, Method> {
  return { grant: provider.grant };
}

function authCodeRefreshProviderEntry<
  Type extends AuthCodeGrantConnectorType & RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token">,
>(
  provider: AuthCodeConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
  },
): ConnectorAuthCodeProviderEntry<Type, Method> &
  ConnectorRefreshTokenAccessProviderEntry<Type, Method> {
  return { grant: provider.grant, access: provider.access };
}

function authCodeTokenRevokeProviderEntry<
  Type extends AuthCodeGrantConnectorType & TokenRevokeConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByRevokeKind<Type, "token-revoke">,
>(
  provider: AuthCodeConnectorAuthProvider<Type, Method> & {
    readonly revoke: TokenRevokeProvider<Type, Method>;
  },
): ConnectorAuthCodeProviderEntry<Type, Method> &
  ConnectorTokenRevokeProviderEntry<Type, Method> {
  return { grant: provider.grant, revoke: provider.revoke };
}

function authCodeRefreshTokenRevokeProviderEntry<
  Type extends AuthCodeGrantConnectorType &
    RefreshTokenAccessConnectorType &
    TokenRevokeConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token"> &
    ConnectorAuthMethodIdsByRevokeKind<Type, "token-revoke">,
>(
  provider: AuthCodeConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
    readonly revoke: TokenRevokeProvider<Type, Method>;
  },
): ConnectorAuthCodeProviderEntry<Type, Method> &
  ConnectorRefreshTokenAccessProviderEntry<Type, Method> &
  ConnectorTokenRevokeProviderEntry<Type, Method> {
  return {
    grant: provider.grant,
    access: provider.access,
    revoke: provider.revoke,
  };
}

function deviceAuthProviderEntry<
  Type extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<Type>,
>(
  provider: DeviceAuthConnectorAuthProvider<Type, Method>,
): ConnectorDeviceAuthProviderEntry<Type, Method> {
  return { grant: provider.grant };
}

function deviceAuthRefreshProviderEntry<
  Type extends DeviceAuthGrantConnectorType & RefreshTokenAccessConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<Type> &
    ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token">,
>(
  provider: DeviceAuthConnectorAuthProvider<Type, Method> & {
    readonly access: RefreshTokenAccessProvider<Type, Method>;
  },
): ConnectorDeviceAuthProviderEntry<Type, Method> &
  ConnectorRefreshTokenAccessProviderEntry<Type, Method> {
  return { grant: provider.grant, access: provider.access };
}

function refreshProviderEntry<
  Type extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token">,
>(provider: {
  readonly access: RefreshTokenAccessProvider<Type, Method>;
}): ConnectorRefreshTokenAccessProviderEntry<Type, Method> {
  return { access: provider.access };
}

function connectorRefreshTokenAccessProviderFor<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
>(type: T, authMethod: Method): RefreshTokenAccessProvider<T, Method> {
  const entries: ConnectorRefreshTokenAccessProviderEntries<T> =
    CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type];
  return entries[authMethod].access;
}

function connectorAuthCodeGrantProviderFor<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T>,
>(type: T, authMethod: Method): ConnectorAuthCodeGrantProvider<T, Method> {
  return CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type][authMethod].grant;
}

function connectorDeviceAuthGrantProviderFor<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
>(type: T, authMethod: Method): ConnectorDeviceAuthGrantProvider<T, Method> {
  return CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type][authMethod].grant;
}

async function revokeTokenRevokeConnectorAccessToken<
  T extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
>(args: {
  readonly type: T;
  readonly authMethod: Method;
  readonly readEnv: ConnectorEnvReader;
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
  if (!authClient || !isStaticConfidentialConnectorAuthClient(authClient)) {
    return { status: "unsupported" };
  }

  await revoke.revokeToken({
    authClient,
    inputs: await args.loadInputs(),
  });
  return { status: "revoked" };
}

function connectorTokenRevokeProviderFor<
  T extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
>(type: T, authMethod: Method): TokenRevokeProvider<T, Method> {
  const entries: ConnectorTokenRevokeProviderEntries<T> =
    CONNECTOR_AUTH_METHOD_PROVIDER_REGISTRY[type];
  return entries[authMethod].revoke;
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
  lark: { "api-token": refreshProviderEntry(larkProvider) },
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
    "api-token": refreshProviderEntry(testOauthApiTokenProvider),
    api: authCodeRefreshProviderEntry(testOauthApiProvider),
  },
  "test-oauth-device": {
    oauth: deviceAuthProviderEntry(testOauthDeviceProvider),
    api: deviceAuthProviderEntry(testOauthDeviceApiProvider),
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

type ConnectorAuthCodeResolvedMethodClient =
  ConnectorResolvedAuthMethodClientByGrantKind<"auth-code">;

type ConnectorDeviceAuthResolvedMethodClient =
  ConnectorResolvedAuthMethodClientByGrantKind<"device-auth">;

type ConnectorAuthCodeAuthorizationUrlArgs =
  ConnectorAuthCodeResolvedMethodClient & {
    readonly redirectUri: string;
    readonly state: string;
  };

type ConnectorAuthCodeExchangeCallArgs =
  ConnectorAuthCodeResolvedMethodClient & {
    readonly code: string;
    readonly redirectUri: string;
    readonly state: string | undefined;
    readonly codeVerifier: string | undefined;
    readonly oauthContext: string | undefined;
  };

type ConnectorDeviceAuthorizationStartCallArgs =
  ConnectorDeviceAuthResolvedMethodClient & {
    readonly options: ConnectorDeviceAuthStartOptions;
  };

type ConnectorDeviceAuthorizationPollCallArgs =
  ConnectorDeviceAuthResolvedMethodClient & {
    readonly deviceCode: string;
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
}): Promise<OAuthDeviceAuthPollResult<T, Method>> {
  const provider = connectorDeviceAuthGrantProviderFor(
    args.type,
    args.authMethod,
  );
  return await provider.pollDeviceAuth({
    authClient: args.authClient,
    deviceCode: args.deviceCode,
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

  return await revokeTokenRevokeConnectorAccessToken({
    type: authMethodRef.type,
    authMethod: authMethodRef.authMethod,
    readEnv: args.readEnv,
    loadInputs: args.loadInputs,
  });
}
