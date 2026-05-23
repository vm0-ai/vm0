import type {
  ConnectorType,
  OAuthAuthCodeConnectorType,
  OAuthConnectorType,
  OAuthDeviceAuthConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorOAuthDeviceAuthConfig,
  getRuntimeAvailableConnectorTypes as getRuntimeAvailableConnectorTypesFromEnv,
  isStaticConfidentialConnectorOAuthCredentials,
  isStaticConnectorOAuthCredentials,
  type ConnectorOAuthCredentials,
} from "@vm0/connectors/connector-utils";
import {
  type AuthUrlResult,
  type ConnectorOAuthAuthorizeArgs,
  type ConnectorOAuthDeviceAuthPollArgs,
  type ConnectorOAuthDeviceAuthStartArgs,
  type ConnectorOAuthExchangeArgs,
  type ConnectorOAuthProviderFor,
  type OAuthAuthorizeArgs,
  type OAuthDeviceAuthPollArgs,
  type OAuthDeviceAuthPollResult,
  type OAuthDeviceAuthStartArgs,
  type OAuthDeviceAuthStartResult,
  type OAuthExchangeArgs,
  type OAuthRefreshArgs,
  type OAuthRefreshResult,
  providerEnvFromObject,
  isOAuthRefreshProvider,
  type OAuthTokenResult,
  type ProviderEnv,
} from "./provider-types";
import { ahrefsProvider } from "./providers/ahrefs-provider";
import { airtableProvider } from "./providers/airtable-provider";
import { asanaProvider } from "./providers/asana-provider";
import { base44Provider } from "./providers/base44-provider";
import { canvaProvider } from "./providers/canva-provider";
import { closeProvider } from "./providers/close-provider";
import { deelProvider } from "./providers/deel-provider";
import { docusignProvider } from "./providers/docusign-provider";
import { dropboxProvider } from "./providers/dropbox-provider";
import { figmaProvider } from "./providers/figma-provider";
import { garminConnectProvider } from "./providers/garmin-connect-provider";
import { gumroadProvider } from "./providers/gumroad-provider";
import { githubProvider } from "./providers/github-provider";
import { gmailProvider } from "./providers/gmail-provider";
import { hubspotProvider } from "./providers/hubspot-provider";
import { googleAdsProvider } from "./providers/google-ads-provider";
import { googleCalendarProvider } from "./providers/google-calendar-provider";
import { googleDocsProvider } from "./providers/google-docs-provider";
import { googleDriveProvider } from "./providers/google-drive-provider";
import { googleMeetProvider } from "./providers/google-meet-provider";
import { googleSheetsProvider } from "./providers/google-sheets-provider";
import { linearProvider } from "./providers/linear-provider";
import { mailchimpProvider } from "./providers/mailchimp-provider";
import { mercuryProvider } from "./providers/mercury-provider";
import { mondayProvider } from "./providers/monday-provider";
import { neonProvider } from "./providers/neon-provider";
import { notionProvider } from "./providers/notion-provider";
import { outlookCalendarProvider } from "./providers/outlook-calendar-provider";
import { outlookMailProvider } from "./providers/outlook-mail-provider";
import { redditProvider } from "./providers/reddit-provider";
import { intervalsIcuProvider } from "./providers/intervals-icu-provider";
import { sentryProvider } from "./providers/sentry-provider";
import { slackProvider } from "./providers/slack-provider";
import { stravaProvider } from "./providers/strava-provider";
import { stripeProvider } from "./providers/stripe-provider";
import { todoistProvider } from "./providers/todoist-provider";
import { vercelProvider } from "./providers/vercel-provider";
import { webflowProvider } from "./providers/webflow-provider";
import { supabaseProvider } from "./providers/supabase-provider";
import { metaAdsProvider } from "./providers/meta-ads-provider";
import { posthogProvider } from "./providers/posthog-provider";
import { spotifyProvider } from "./providers/spotify-provider";
import { xProvider } from "./providers/x-provider";
import { xeroProvider } from "./providers/xero-provider";
import { zoomProvider } from "./providers/zoom-provider";
import { testOauthProvider } from "./providers/test-oauth-provider";
import { testOauthDeviceProvider } from "./providers/test-oauth-device-provider";

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
export { providerEnvFromObject, isOAuthRefreshProvider };

type ConnectorOAuthProviderMap = {
  readonly [Type in OAuthConnectorType]: ConnectorOAuthProviderFor<Type>;
};

type DispatchRefreshProvider = {
  refreshToken(args: OAuthRefreshArgs): Promise<OAuthRefreshResult>;
};

export type ConnectorOAuthSecretMetadata =
  | {
      readonly accessSecretName: string;
      readonly isRefreshable: false;
    }
  | {
      readonly accessSecretName: string;
      readonly refreshSecretName: string;
      readonly isRefreshable: true;
    };

function connectorProviderFor<T extends OAuthConnectorType>(
  type: T,
): ConnectorOAuthProviderFor<T> {
  return CONNECTOR_OAUTH_PROVIDERS[type];
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

const CONNECTOR_OAUTH_PROVIDERS: ConnectorOAuthProviderMap = {
  ahrefs: ahrefsProvider,
  airtable: airtableProvider,
  asana: asanaProvider,
  base44: base44Provider,
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
  "test-oauth-device": testOauthDeviceProvider,
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

  const provider = connectorProviderFor(type);
  const accessSecretName = provider.getSecretName();
  if (!isOAuthRefreshProvider(provider)) {
    return {
      accessSecretName,
      isRefreshable: false,
    };
  }

  return {
    accessSecretName,
    refreshSecretName: provider.getRefreshSecretName(),
    isRefreshable: true,
  };
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
  const provider = connectorProviderFor(args.type);
  return await provider.buildAuthUrl({
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
  const provider = connectorProviderFor(args.type);
  return await provider.exchangeCode({
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
  const provider = connectorProviderFor(args.type);
  const oauthConfig = getConnectorOAuthDeviceAuthConfig(args.type);
  return await provider.startDeviceAuth({
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
  const provider = connectorProviderFor(args.type);
  return await provider.pollDeviceAuth({
    ...connectorCredentialArgs(args.credentials),
    deviceCode: args.deviceCode,
  } as ConnectorOAuthDeviceAuthPollArgs<T>);
}

export async function refreshConnectorOAuthToken(args: {
  readonly type: OAuthConnectorType;
  readonly credentials: ConnectorOAuthCredentials;
  readonly refreshToken: string;
}): Promise<OAuthRefreshResult> {
  assertConfiguredConnectorOAuthCredentials(args.type, args.credentials);
  const provider = connectorProviderFor(args.type);
  if (!isOAuthRefreshProvider(provider)) {
    throw new Error(`${args.type} OAuth provider does not support refresh`);
  }
  const dispatchProvider = provider as unknown as DispatchRefreshProvider;
  return await dispatchProvider.refreshToken({
    ...connectorCredentialArgs(args.credentials),
    refreshToken: args.refreshToken,
  });
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
