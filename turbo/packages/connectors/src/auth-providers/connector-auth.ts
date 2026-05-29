import type {
  ConnectorType,
  AuthCodeGrantConnectorType,
  ConnectorAuthProviderType,
  DeviceAuthGrantConnectorType,
  ConnectorAuthMethodIdsByAccessKind,
  RefreshTokenAccessConnectorType,
} from "@vm0/connectors/connectors";
import {
  connectorAuthMethodSupportsRefreshTokenAccess,
  getRuntimeAvailableConnectorTypes as getRuntimeAvailableConnectorTypesFromEnv,
  hasConnectorAuthCodeGrant,
  isStaticConfidentialConnectorAuthClient,
  isStaticConnectorAuthClient,
  type ConnectorAuthClient,
} from "@vm0/connectors/connector-utils";
import {
  getAuthProviderSecretMetadata,
  type AuthProviderSecretMetadata,
} from "./secret-metadata";
import type {
  AuthCodeConnectorAuthProvider,
  DeviceAuthConnectorAuthProvider,
  ConnectorAuthProviderRevoke,
  RefreshTokenAccessProvider,
} from "./types";
import {
  type AuthUrlResult,
  type ConnectorAuthCodeAuthorizeArgs,
  type ConnectorDeviceAuthorizationPollArgs,
  type ConnectorDeviceAuthorizationStartArgs,
  type ConnectorAuthCodeExchangeArgs,
  type ConnectorAuthProviderRefreshArgs,
  type ConnectorAuthProviderRevokeArgs,
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
import { getDeviceAuthGrantConfig } from "./oauth/grant-config";
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

type AuthCodeConnectorAuthProviderMap = {
  readonly [Type in AuthCodeGrantConnectorType]: AuthCodeConnectorAuthProvider<Type>;
};

type DeviceAuthConnectorAuthProviderMap = {
  readonly [Type in DeviceAuthGrantConnectorType]: DeviceAuthConnectorAuthProvider<Type>;
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

export type ConnectorAuthProviderSecretMetadata = AuthProviderSecretMetadata;

export interface ConnectorAuthProviderClientArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

function deviceAuthConnectorProviderFor<T extends DeviceAuthGrantConnectorType>(
  type: T,
): DeviceAuthConnectorAuthProviderMap[T] {
  return DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS[type];
}

function connectorRefreshTokenAccessProviderFor<
  T extends RefreshTokenAccessConnectorType,
>(type: T, authMethod: string): RefreshTokenAccessProvider<T> | undefined {
  const providers = CONNECTOR_REFRESH_TOKEN_ACCESS_PROVIDERS[type] as Readonly<
    Record<string, RefreshTokenAccessProvider<T>>
  >;
  return providers[authMethod];
}

function connectorRevokeProviderFor<T extends ConnectorAuthProviderType>(
  type: T,
): ConnectorAuthProviderRevoke<T> {
  if (hasConnectorAuthCodeGrant(type)) {
    return AUTH_CODE_CONNECTOR_AUTH_PROVIDERS[type]
      .revoke as ConnectorAuthProviderRevoke<T>;
  }

  return deviceAuthConnectorProviderFor(type)
    .revoke as ConnectorAuthProviderRevoke<T>;
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

const AUTH_CODE_CONNECTOR_AUTH_PROVIDERS: AuthCodeConnectorAuthProviderMap = {
  ahrefs: ahrefsProvider,
  airtable: airtableProvider,
  asana: asanaProvider,
  canva: canvaProvider,
  close: closeProvider,
  deel: deelProvider,
  docusign: docusignProvider,
  dropbox: dropboxProvider,
  figma: figmaProvider,
  "garmin-connect": garminConnectProvider,
  gumroad: gumroadProvider,
  github: githubProvider,
  gmail: gmailProvider,
  hubspot: hubspotProvider,
  "google-ads": googleAdsProvider,
  "google-calendar": googleCalendarProvider,
  "google-docs": googleDocsProvider,
  "google-drive": googleDriveProvider,
  "google-meet": googleMeetProvider,
  "google-sheets": googleSheetsProvider,
  linear: linearProvider,
  mailchimp: mailchimpProvider,
  mercury: mercuryProvider,
  monday: mondayProvider,
  neon: neonProvider,
  notion: notionProvider,
  "outlook-calendar": outlookCalendarProvider,
  "outlook-mail": outlookMailProvider,
  reddit: redditProvider,
  "intervals-icu": intervalsIcuProvider,
  sentry: sentryProvider,
  slack: slackProvider,
  strava: stravaProvider,
  stripe: stripeProvider,
  todoist: todoistProvider,
  vercel: vercelProvider,
  webflow: webflowProvider,
  supabase: supabaseProvider,
  "meta-ads": metaAdsProvider,
  posthog: posthogProvider,
  spotify: spotifyProvider,
  x: xProvider,
  xero: xeroProvider,
  zoom: zoomProvider,
  "test-oauth": testOauthProvider,
};

const DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS: DeviceAuthConnectorAuthProviderMap =
  {
    base44: base44Provider,
    slock: slockProvider,
    "test-oauth-device": testOauthDeviceProvider,
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
): type is AuthCodeGrantConnectorType {
  return Object.hasOwn(AUTH_CODE_CONNECTOR_AUTH_PROVIDERS, type);
}

export function hasConnectorDeviceAuthGrantProvider(
  type: string,
): type is DeviceAuthGrantConnectorType {
  return Object.hasOwn(DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS, type);
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

export function getConnectorAuthProviderSecretMetadata(
  type: ConnectorAuthProviderType,
): ConnectorAuthProviderSecretMetadata;
export function getConnectorAuthProviderSecretMetadata(
  type: string,
): ConnectorAuthProviderSecretMetadata | undefined;
export function getConnectorAuthProviderSecretMetadata(
  type: string,
): ConnectorAuthProviderSecretMetadata | undefined {
  if (hasConnectorAuthCodeGrantProvider(type)) {
    return getAuthProviderSecretMetadata(
      AUTH_CODE_CONNECTOR_AUTH_PROVIDERS[type],
    );
  }

  if (hasConnectorDeviceAuthGrantProvider(type)) {
    return getAuthProviderSecretMetadata(
      DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS[type],
    );
  }

  return undefined;
}

export async function buildConnectorAuthCodeAuthorizationUrl<
  T extends AuthCodeGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authClient: ConnectorAuthClient;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<string | AuthUrlResult> {
  return await AUTH_CODE_CONNECTOR_AUTH_PROVIDERS[args.type].grant.buildAuthUrl(
    {
      ...connectorAuthProviderClientArgs(args.authClient),
      redirectUri: args.redirectUri,
      state: args.state,
    } as ConnectorAuthCodeAuthorizeArgs<T>,
  );
}

export async function exchangeConnectorAuthCode<
  T extends AuthCodeGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authClient: ConnectorAuthClient;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<OAuthTokenResult> {
  return await AUTH_CODE_CONNECTOR_AUTH_PROVIDERS[args.type].grant.exchangeCode(
    {
      ...connectorAuthProviderClientArgs(args.authClient),
      code: args.code,
      redirectUri: args.redirectUri,
      state: args.state,
      codeVerifier: args.codeVerifier,
      oauthContext: args.oauthContext,
    } as ConnectorAuthCodeExchangeArgs<T>,
  );
}

export async function startConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authClient: ConnectorAuthClient;
}): Promise<OAuthDeviceAuthStartResult> {
  const grant = getDeviceAuthGrantConfig(args.type);
  return await DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS[
    args.type
  ].grant.startDeviceAuth({
    ...connectorAuthProviderClientArgs(args.authClient),
    scopes: grant.scopes,
  } as ConnectorDeviceAuthorizationStartArgs<T>);
}

export async function pollConnectorDeviceAuthorization<
  T extends DeviceAuthGrantConnectorType,
>(args: {
  readonly type: T;
  readonly authClient: ConnectorAuthClient;
  readonly deviceCode: string;
}): Promise<OAuthDeviceAuthPollResult> {
  return await DEVICE_AUTH_CONNECTOR_AUTH_PROVIDERS[
    args.type
  ].grant.pollDeviceAuth({
    ...connectorAuthProviderClientArgs(args.authClient),
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
}): Promise<OAuthRefreshResult> {
  if (
    !connectorAuthMethodSupportsRefreshTokenAccess(args.type, args.authMethod)
  ) {
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
    refreshToken: args.refreshToken,
  } as ConnectorAuthProviderRefreshArgs<T>);
}

export async function revokeConnectorAuthProviderAccessToken<
  T extends ConnectorAuthProviderType,
>(args: {
  readonly type: T;
  readonly authClient: ConnectorAuthClient;
  readonly loadAccessToken: () => string | Promise<string>;
}): Promise<ConnectorAuthProviderAccessTokenRevokeResult> {
  const revoke = connectorRevokeProviderFor(args.type);

  switch (revoke.kind) {
    case "none":
      return { status: "unsupported" };

    case "token-revoke":
      await revoke.revokeToken({
        ...connectorAuthProviderClientArgs(args.authClient),
        accessToken: await args.loadAccessToken(),
      } as ConnectorAuthProviderRevokeArgs<T>);
      return { status: "revoked" };
  }
}

/**
 * Returns connector types the current runtime environment can offer as
 * connection candidates.
 */
export function getRuntimeAvailableConnectorTypes(
  currentEnv: ProviderEnv,
): ConnectorType[] {
  return getRuntimeAvailableConnectorTypesFromEnv((name) => {
    const value = currentEnv[name];
    return typeof value === "string" ? value : undefined;
  });
}
