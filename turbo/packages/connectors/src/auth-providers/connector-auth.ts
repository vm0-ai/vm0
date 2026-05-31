import {
  connectorTypeSchema,
  type ConnectorAuthCodeGrantAuthMethodId,
  type AuthCodeGrantConnectorType,
  type ConnectorType,
  type ConnectorAuthProviderType,
  type ConnectorDeviceAuthGrantAuthMethodId,
  type DeviceAuthGrantConnectorType,
  type ConnectorAuthMethodIdsByAccessKind,
  type RefreshTokenAccessConnectorType,
  type TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import {
  connectorAuthMethodSupportsTokenRevoke,
  getConfiguredConnectorAuthMethods,
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
import { testOauthProvider } from "./oauth/providers/test-oauth-provider";
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

type ConnectorAuthCodeGrantProviderEntries<
  Type extends AuthCodeGrantConnectorType,
> = {
  readonly [Method in ConnectorAuthCodeGrantAuthMethodId<Type>]: AuthCodeConnectorAuthProvider<Type>;
};

type AuthCodeConnectorAuthProviderMap = {
  readonly [Type in AuthCodeGrantConnectorType]: ConnectorAuthCodeGrantProviderEntries<Type>;
};

type ConnectorDeviceAuthGrantProviderEntries<
  Type extends DeviceAuthGrantConnectorType,
> = {
  readonly [Method in ConnectorDeviceAuthGrantAuthMethodId<Type>]: DeviceAuthConnectorAuthProvider<Type>;
};

type DeviceAuthConnectorAuthProviderMap = {
  readonly [Type in DeviceAuthGrantConnectorType]: ConnectorDeviceAuthGrantProviderEntries<Type>;
};

type ConnectorRefreshTokenAccessProviderEntries<
  Type extends RefreshTokenAccessConnectorType,
> = {
  readonly [Method in ConnectorAuthMethodIdsByAccessKind<
    Type,
    "refresh-token"
  >]: RefreshTokenAccessProvider<Type>;
};

type ConnectorRefreshTokenAccessProviderMap = {
  readonly [Type in RefreshTokenAccessConnectorType]: ConnectorRefreshTokenAccessProviderEntries<Type>;
};

export interface ConnectorAuthProviderClientArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

function connectorRefreshTokenAccessProviderFor<
  T extends RefreshTokenAccessConnectorType,
>(type: T, authMethod: string): RefreshTokenAccessProvider<T> | undefined {
  const providers = CONNECTOR_REFRESH_TOKEN_ACCESS_PROVIDERS[type] as Readonly<
    Record<string, RefreshTokenAccessProvider<T>>
  >;
  return providers[authMethod];
}

function connectorAuthCodeGrantProviderFor<
  T extends AuthCodeGrantConnectorType,
>(
  type: T,
  authMethod: ConnectorAuthCodeGrantAuthMethodId<T>,
): AuthCodeConnectorAuthProvider<T> {
  const providers: ConnectorAuthCodeGrantProviderEntries<T> =
    AUTH_CODE_CONNECTOR_AUTH_PROVIDERS[type];
  return providers[authMethod];
}

function connectorDeviceAuthGrantProviderFor<
  T extends DeviceAuthGrantConnectorType,
>(
  type: T,
  authMethod: ConnectorDeviceAuthGrantAuthMethodId<T>,
): DeviceAuthConnectorAuthProvider<T> {
  const providers: ConnectorDeviceAuthGrantProviderEntries<T> =
    DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS[type];
  return providers[authMethod];
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
  switch (args.type) {
    case "github": {
      const authClient = resolveConnectorAuthClientForMethod(
        "github",
        args.authMethod,
        args.readEnv,
      );
      if (!authClient || !isStaticConfidentialConnectorAuthClient(authClient)) {
        return { status: "unsupported" };
      }
      await githubProvider.revoke.revokeToken({
        clientId: authClient.clientId,
        clientSecret: authClient.clientSecret,
        accessToken: await args.loadAccessToken(),
      });
      return { status: "revoked" };
    }
    case "linear": {
      const authClient = resolveConnectorAuthClientForMethod(
        "linear",
        args.authMethod,
        args.readEnv,
      );
      if (!authClient || !isStaticConfidentialConnectorAuthClient(authClient)) {
        return { status: "unsupported" };
      }
      await linearProvider.revoke.revokeToken({
        clientId: authClient.clientId,
        clientSecret: authClient.clientSecret,
        accessToken: await args.loadAccessToken(),
      });
      return { status: "revoked" };
    }
    case "slack": {
      const authClient = resolveConnectorAuthClientForMethod(
        "slack",
        args.authMethod,
        args.readEnv,
      );
      if (!authClient || !isStaticConfidentialConnectorAuthClient(authClient)) {
        return { status: "unsupported" };
      }
      await slackProvider.revoke.revokeToken({
        clientId: authClient.clientId,
        clientSecret: authClient.clientSecret,
        accessToken: await args.loadAccessToken(),
      });
      return { status: "revoked" };
    }
  }
  const exhaustive: never = args.type;
  return exhaustive;
}

const AUTH_CODE_CONNECTOR_AUTH_PROVIDERS: AuthCodeConnectorAuthProviderMap = {
  ahrefs: { oauth: ahrefsProvider },
  airtable: { oauth: airtableProvider },
  asana: { oauth: asanaProvider },
  canva: { oauth: canvaProvider },
  close: { oauth: closeProvider },
  deel: { oauth: deelProvider },
  docusign: { oauth: docusignProvider },
  dropbox: { oauth: dropboxProvider },
  figma: { oauth: figmaProvider },
  "garmin-connect": { oauth: garminConnectProvider },
  gumroad: { oauth: gumroadProvider },
  github: { oauth: githubProvider },
  gmail: { oauth: gmailProvider },
  hubspot: { oauth: hubspotProvider },
  "google-ads": { oauth: googleAdsProvider },
  "google-calendar": { oauth: googleCalendarProvider },
  "google-docs": { oauth: googleDocsProvider },
  "google-drive": { oauth: googleDriveProvider },
  "google-meet": { oauth: googleMeetProvider },
  "google-sheets": { oauth: googleSheetsProvider },
  linear: { oauth: linearProvider },
  mailchimp: { oauth: mailchimpProvider },
  mercury: { oauth: mercuryProvider },
  monday: { oauth: mondayProvider },
  neon: { oauth: neonProvider },
  notion: { oauth: notionProvider },
  "outlook-calendar": { oauth: outlookCalendarProvider },
  "outlook-mail": { oauth: outlookMailProvider },
  reddit: { oauth: redditProvider },
  "intervals-icu": { oauth: intervalsIcuProvider },
  sentry: { oauth: sentryProvider },
  slack: { oauth: slackProvider },
  strava: { oauth: stravaProvider },
  stripe: { oauth: stripeProvider },
  todoist: { oauth: todoistProvider },
  vercel: { oauth: vercelProvider },
  webflow: { oauth: webflowProvider },
  supabase: { oauth: supabaseProvider },
  "meta-ads": { oauth: metaAdsProvider },
  posthog: { oauth: posthogProvider },
  spotify: { oauth: spotifyProvider },
  x: { oauth: xProvider },
  xero: { oauth: xeroProvider },
  zoom: { oauth: zoomProvider },
  "test-oauth": { oauth: testOauthProvider },
};

const DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS: DeviceAuthConnectorAuthProviderMap =
  {
    base44: { oauth: base44Provider },
    slock: { oauth: slockProvider },
    "test-oauth-device": { oauth: testOauthDeviceProvider },
  };

const CONNECTOR_REFRESH_TOKEN_ACCESS_PROVIDERS: ConnectorRefreshTokenAccessProviderMap =
  {
    ahrefs: { oauth: ahrefsProvider.access },
    airtable: { oauth: airtableProvider.access },
    asana: { oauth: asanaProvider.access },
    base44: { oauth: base44Provider.access },
    canva: { oauth: canvaProvider.access },
    close: { oauth: closeProvider.access },
    deel: { oauth: deelProvider.access },
    docusign: { oauth: docusignProvider.access },
    dropbox: { oauth: dropboxProvider.access },
    figma: { oauth: figmaProvider.access },
    "garmin-connect": { oauth: garminConnectProvider.access },
    gmail: { oauth: gmailProvider.access },
    "google-ads": { oauth: googleAdsProvider.access },
    "google-calendar": { oauth: googleCalendarProvider.access },
    "google-docs": { oauth: googleDocsProvider.access },
    "google-drive": { oauth: googleDriveProvider.access },
    "google-meet": { oauth: googleMeetProvider.access },
    "google-sheets": { oauth: googleSheetsProvider.access },
    gumroad: { oauth: gumroadProvider.access },
    hubspot: { oauth: hubspotProvider.access },
    linear: { oauth: linearProvider.access },
    mercury: { oauth: mercuryProvider.access },
    monday: { oauth: mondayProvider.access },
    neon: { oauth: neonProvider.access },
    notion: { oauth: notionProvider.access },
    "outlook-calendar": { oauth: outlookCalendarProvider.access },
    "outlook-mail": { oauth: outlookMailProvider.access },
    posthog: { oauth: posthogProvider.access },
    reddit: { oauth: redditProvider.access },
    sentry: { oauth: sentryProvider.access },
    slock: { oauth: slockProvider.access },
    spotify: { oauth: spotifyProvider.access },
    strava: { oauth: stravaProvider.access },
    stripe: { oauth: stripeProvider.access },
    supabase: { oauth: supabaseProvider.access },
    "test-oauth": { oauth: testOauthProvider.access },
    x: { oauth: xProvider.access },
    xero: { oauth: xeroProvider.access },
    zoom: { oauth: zoomProvider.access },
  };

export function hasConnectorAuthProvider(
  type: string,
): type is ConnectorAuthProviderType {
  return (
    hasConnectorAuthCodeGrantProvider(type) ||
    hasConnectorDeviceAuthGrantProvider(type)
  );
}

export function hasConnectorAuthCodeGrantProvider(
  type: string,
): type is AuthCodeGrantConnectorType;
export function hasConnectorAuthCodeGrantProvider<
  T extends AuthCodeGrantConnectorType,
>(
  type: T,
  authMethod: string,
): authMethod is ConnectorAuthCodeGrantAuthMethodId<T>;
export function hasConnectorAuthCodeGrantProvider(
  type: string,
  authMethod: string,
): boolean;
export function hasConnectorAuthCodeGrantProvider(
  type: string,
  authMethod?: string,
): boolean {
  if (authMethod === undefined) {
    return Object.hasOwn(AUTH_CODE_CONNECTOR_AUTH_PROVIDERS, type);
  }
  return hasConnectorAuthCodeGrantProviderForMethod(type, authMethod);
}

function hasConnectorAuthCodeGrantProviderForMethod(
  type: string,
  authMethod: string,
): boolean {
  const connectorType = connectorTypeSchema.safeParse(type);
  if (!connectorType.success) {
    return false;
  }
  if (!hasConnectorAuthCodeGrantProvider(connectorType.data)) {
    return false;
  }
  return Object.hasOwn(
    AUTH_CODE_CONNECTOR_AUTH_PROVIDERS[connectorType.data],
    authMethod,
  );
}

export function hasConnectorDeviceAuthGrantProvider(
  type: string,
): type is DeviceAuthGrantConnectorType;
export function hasConnectorDeviceAuthGrantProvider<
  T extends DeviceAuthGrantConnectorType,
>(
  type: T,
  authMethod: string,
): authMethod is ConnectorDeviceAuthGrantAuthMethodId<T>;
export function hasConnectorDeviceAuthGrantProvider(
  type: string,
  authMethod: string,
): boolean;
export function hasConnectorDeviceAuthGrantProvider(
  type: string,
  authMethod?: string,
): boolean {
  if (authMethod === undefined) {
    return Object.hasOwn(DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS, type);
  }
  return hasConnectorDeviceAuthGrantProviderForMethod(type, authMethod);
}

function hasConnectorDeviceAuthGrantProviderForMethod(
  type: string,
  authMethod: string,
): boolean {
  const connectorType = connectorTypeSchema.safeParse(type);
  if (!connectorType.success) {
    return false;
  }
  if (!hasConnectorDeviceAuthGrantProvider(connectorType.data)) {
    return false;
  }
  return Object.hasOwn(
    DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS[connectorType.data],
    authMethod,
  );
}

export function hasConnectorRefreshTokenAccessProvider(
  type: string,
  authMethod?: string,
): type is RefreshTokenAccessConnectorType {
  if (!Object.hasOwn(CONNECTOR_REFRESH_TOKEN_ACCESS_PROVIDERS, type)) {
    return false;
  }
  if (authMethod === undefined) {
    return true;
  }
  const providers = CONNECTOR_REFRESH_TOKEN_ACCESS_PROVIDERS[
    type as RefreshTokenAccessConnectorType
  ] as Readonly<Record<string, unknown>>;
  return Object.hasOwn(providers, authMethod);
}

export function hasConnectorTokenRevokeProvider(
  type: string,
  authMethod?: string,
): type is TokenRevokeConnectorType {
  const connectorType = connectorTypeSchema.safeParse(type);
  if (!connectorType.success) {
    return false;
  }
  if (authMethod === undefined) {
    return getConfiguredConnectorAuthMethods(connectorType.data).some(
      (configuredAuthMethod) => {
        return hasConnectorTokenRevokeProvider(
          connectorType.data,
          configuredAuthMethod,
        );
      },
    );
  }
  return connectorAuthMethodSupportsTokenRevoke(connectorType.data, authMethod);
}

export async function buildConnectorAuthCodeAuthorizationUrl<
  T extends AuthCodeGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authMethod: ConnectorAuthCodeGrantAuthMethodId<T>;
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
  return await provider.grant.buildAuthUrl({
    ...connectorAuthProviderClientArgs(args.authClient),
    authCodeGrant,
    redirectUri: args.redirectUri,
    state: args.state,
  } as ConnectorAuthCodeAuthorizeArgs<T>);
}

export async function exchangeConnectorAuthCode<
  T extends AuthCodeGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authMethod: ConnectorAuthCodeGrantAuthMethodId<T>;
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
  return await provider.grant.exchangeCode({
    ...connectorAuthProviderClientArgs(args.authClient),
    authCodeGrant,
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  } as ConnectorAuthCodeExchangeArgs<T>);
}

export async function startConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authMethod: ConnectorDeviceAuthGrantAuthMethodId<T>;
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
  return await provider.grant.startDeviceAuth({
    ...connectorAuthProviderClientArgs(args.authClient),
    deviceAuthGrant,
    scopes: getConnectorAuthMethodGrantScopes(args.type, args.authMethod),
  } as ConnectorDeviceAuthorizationStartArgs<T>);
}

export async function pollConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authMethod: ConnectorDeviceAuthGrantAuthMethodId<T>;
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
  return await provider.grant.pollDeviceAuth({
    ...connectorAuthProviderClientArgs(args.authClient),
    deviceAuthGrant,
    deviceCode: args.deviceCode,
  } as ConnectorDeviceAuthorizationPollArgs<T>);
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
  return await access.refreshToken({
    ...args.clientArgs,
    tokenUrl: method.access.tokenUrl,
    refreshToken: args.refreshToken,
    signal: args.signal,
  } as ConnectorAuthProviderRefreshArgs<T>);
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
