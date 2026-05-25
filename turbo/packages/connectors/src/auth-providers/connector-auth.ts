import type {
  ConnectorType,
  OAuthAuthCodeConnectorType,
  OAuthConnectorType,
  OAuthDeviceAuthConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorOAuthDeviceAuthConfig,
  getRuntimeAvailableConnectorTypes as getRuntimeAvailableConnectorTypesFromEnv,
  isOAuthAuthCodeConnectorType,
  isStaticConfidentialConnectorOAuthCredentials,
  isStaticConnectorOAuthCredentials,
  type ConnectorOAuthCredentials,
} from "@vm0/connectors/connector-utils";
import {
  getAuthProviderSecretMetadata,
  type AuthProviderSecretMetadata,
} from "./secret-metadata";
import type {
  AuthCodeConnectorAuthProvider,
  DeviceAuthConnectorAuthProvider,
  OAuthConnectorAccessProvider,
  OAuthConnectorRevokeProvider,
} from "./types";
import {
  type AuthUrlResult,
  type ConnectorOAuthAuthorizeArgs,
  type ConnectorOAuthDeviceAuthPollArgs,
  type ConnectorOAuthDeviceAuthStartArgs,
  type ConnectorOAuthExchangeArgs,
  type ConnectorOAuthRefreshArgs,
  type ConnectorOAuthRevokeArgs,
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

export type ConnectorOAuthRevokeResult =
  | { readonly status: "revoked" }
  | { readonly status: "unsupported" }
  | { readonly status: "unconfigured" };

type AuthCodeConnectorOAuthProviderMap = {
  readonly [Type in OAuthAuthCodeConnectorType]: AuthCodeConnectorAuthProvider<Type>;
};

type DeviceAuthConnectorOAuthProviderMap = {
  readonly [Type in OAuthDeviceAuthConnectorType]: DeviceAuthConnectorAuthProvider<Type>;
};

export type ConnectorOAuthSecretMetadata = AuthProviderSecretMetadata;

function deviceAuthConnectorProviderFor<T extends OAuthDeviceAuthConnectorType>(
  type: T,
): DeviceAuthConnectorOAuthProviderMap[T] {
  return DEVICE_AUTH_CONNECTOR_OAUTH_PROVIDERS[type];
}

function connectorAccessProviderFor<T extends OAuthConnectorType>(
  type: T,
): OAuthConnectorAccessProvider<T> {
  if (isOAuthAuthCodeConnectorType(type)) {
    return AUTH_CODE_CONNECTOR_OAUTH_PROVIDERS[type]
      .access as OAuthConnectorAccessProvider<T>;
  }

  return deviceAuthConnectorProviderFor(type)
    .access as OAuthConnectorAccessProvider<T>;
}

function connectorRevokeProviderFor<T extends OAuthConnectorType>(
  type: T,
): OAuthConnectorRevokeProvider<T> {
  if (isOAuthAuthCodeConnectorType(type)) {
    return AUTH_CODE_CONNECTOR_OAUTH_PROVIDERS[type]
      .revoke as OAuthConnectorRevokeProvider<T>;
  }

  return deviceAuthConnectorProviderFor(type)
    .revoke as OAuthConnectorRevokeProvider<T>;
}

function connectorCredentialArgs(
  credentials: ConnectorOAuthCredentials,
): Pick<OAuthExchangeArgs, "clientId" | "clientSecret"> {
  if (!isStaticConnectorOAuthCredentials(credentials)) {
    return {};
  }
  if (isStaticConfidentialConnectorOAuthCredentials(credentials)) {
    return {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    };
  }
  return { clientId: credentials.clientId };
}

function assertConfiguredConnectorOAuthCredentials(
  type: OAuthConnectorType,
  credentials: ConnectorOAuthCredentials,
): void {
  if (!credentials.configured) {
    throw new Error(`${type} OAuth not configured`);
  }
}

const AUTH_CODE_CONNECTOR_OAUTH_PROVIDERS: AuthCodeConnectorOAuthProviderMap = {
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

const DEVICE_AUTH_CONNECTOR_OAUTH_PROVIDERS: DeviceAuthConnectorOAuthProviderMap =
  {
    base44: base44Provider,
    "test-oauth-device": testOauthDeviceProvider,
  };

const CONNECTOR_OAUTH_PROVIDERS = {
  ...AUTH_CODE_CONNECTOR_OAUTH_PROVIDERS,
  ...DEVICE_AUTH_CONNECTOR_OAUTH_PROVIDERS,
};

export function isOAuthConnectorType(type: string): type is OAuthConnectorType {
  return Object.hasOwn(CONNECTOR_OAUTH_PROVIDERS, type);
}

export function getConnectorOAuthSecretMetadata(
  type: OAuthConnectorType,
): ConnectorOAuthSecretMetadata;
export function getConnectorOAuthSecretMetadata(
  type: string,
): ConnectorOAuthSecretMetadata | undefined;
export function getConnectorOAuthSecretMetadata(
  type: string,
): ConnectorOAuthSecretMetadata | undefined {
  if (!isOAuthConnectorType(type)) {
    return undefined;
  }

  if (isOAuthAuthCodeConnectorType(type)) {
    return getAuthProviderSecretMetadata(
      AUTH_CODE_CONNECTOR_OAUTH_PROVIDERS[type],
    );
  }

  return getAuthProviderSecretMetadata(
    DEVICE_AUTH_CONNECTOR_OAUTH_PROVIDERS[type],
  );
}

export async function buildConnectorOAuthAuthUrl<
  T extends OAuthAuthCodeConnectorType,
>(args: {
  readonly type: T;
  readonly credentials: ConnectorOAuthCredentials;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<string | AuthUrlResult> {
  assertConfiguredConnectorOAuthCredentials(args.type, args.credentials);
  return await AUTH_CODE_CONNECTOR_OAUTH_PROVIDERS[
    args.type
  ].grant.buildAuthUrl({
    ...connectorCredentialArgs(args.credentials),
    redirectUri: args.redirectUri,
    state: args.state,
  } as ConnectorOAuthAuthorizeArgs<T>);
}

export async function exchangeConnectorOAuthCode<
  T extends OAuthAuthCodeConnectorType,
>(args: {
  readonly type: T;
  readonly credentials: ConnectorOAuthCredentials;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}): Promise<OAuthTokenResult> {
  assertConfiguredConnectorOAuthCredentials(args.type, args.credentials);
  return await AUTH_CODE_CONNECTOR_OAUTH_PROVIDERS[
    args.type
  ].grant.exchangeCode({
    ...connectorCredentialArgs(args.credentials),
    code: args.code,
    redirectUri: args.redirectUri,
    state: args.state,
    codeVerifier: args.codeVerifier,
    oauthContext: args.oauthContext,
  } as ConnectorOAuthExchangeArgs<T>);
}

export async function startConnectorOAuthDeviceAuth<
  T extends OAuthDeviceAuthConnectorType,
>(args: {
  readonly type: T;
  readonly credentials: ConnectorOAuthCredentials;
}): Promise<OAuthDeviceAuthStartResult> {
  assertConfiguredConnectorOAuthCredentials(args.type, args.credentials);
  const oauthConfig = getConnectorOAuthDeviceAuthConfig(args.type);
  return await DEVICE_AUTH_CONNECTOR_OAUTH_PROVIDERS[
    args.type
  ].grant.startDeviceAuth({
    ...connectorCredentialArgs(args.credentials),
    scopes: oauthConfig.scopes,
  } as ConnectorOAuthDeviceAuthStartArgs<T>);
}

export async function pollConnectorOAuthDeviceAuth<
  T extends OAuthDeviceAuthConnectorType,
>(args: {
  readonly type: T;
  readonly credentials: ConnectorOAuthCredentials;
  readonly deviceCode: string;
}): Promise<OAuthDeviceAuthPollResult> {
  assertConfiguredConnectorOAuthCredentials(args.type, args.credentials);
  return await DEVICE_AUTH_CONNECTOR_OAUTH_PROVIDERS[
    args.type
  ].grant.pollDeviceAuth({
    ...connectorCredentialArgs(args.credentials),
    deviceCode: args.deviceCode,
  } as ConnectorOAuthDeviceAuthPollArgs<T>);
}

export async function refreshConnectorOAuthToken<
  T extends OAuthConnectorType,
>(args: {
  readonly type: T;
  readonly credentials: ConnectorOAuthCredentials;
  readonly refreshToken: string;
}): Promise<OAuthRefreshResult> {
  assertConfiguredConnectorOAuthCredentials(args.type, args.credentials);
  const access = connectorAccessProviderFor(args.type);

  switch (access.kind) {
    case "none":
      throw new Error(`${args.type} OAuth provider does not support refresh`);

    case "refresh-token":
      return await access.refreshToken({
        ...connectorCredentialArgs(args.credentials),
        refreshToken: args.refreshToken,
      } as ConnectorOAuthRefreshArgs<T>);
  }
}

export async function revokeConnectorOAuthToken<
  T extends OAuthConnectorType,
>(args: {
  readonly type: T;
  readonly credentials: ConnectorOAuthCredentials;
  readonly loadAccessToken: () => string | Promise<string>;
}): Promise<ConnectorOAuthRevokeResult> {
  if (!args.credentials.configured) {
    return { status: "unconfigured" };
  }

  const revoke = connectorRevokeProviderFor(args.type);

  switch (revoke.kind) {
    case "none":
      return { status: "unsupported" };

    case "token-revoke":
      await revoke.revokeToken({
        ...connectorCredentialArgs(args.credentials),
        accessToken: await args.loadAccessToken(),
      } as ConnectorOAuthRevokeArgs<T>);
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
