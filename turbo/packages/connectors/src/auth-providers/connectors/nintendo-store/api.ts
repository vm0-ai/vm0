import type { ConnectorExternalCodeGrantConfig } from "@vm0/connectors/connector-config";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";
import {
  NINTENDO_ACCOUNT_AUTHORIZATION_URL,
  NINTENDO_ACCOUNT_PROFILE_URL,
  NINTENDO_ACCOUNT_SESSION_TOKEN_URL,
  NINTENDO_ACCOUNT_TOKEN_URL,
  buildNintendoAccountAuthorizationUrl,
  createNintendoAccountProviderState,
  exchangeNintendoAccountSessionToken,
  exchangeNintendoAccountSessionTokenCode,
  fetchNintendoAccountProfile,
  nintendoAccountId,
  nintendoAccountUserInfo,
  parseNintendoAccountProviderState,
  parseNintendoAccountSessionTokenCode,
  type NintendoAccountProfile,
  type NintendoAccountProviderState,
  type NintendoAccountSessionToken,
  type NintendoAccountToken,
} from "../nintendo-account";

const NINTENDO_STORE_PROVIDER_LABEL = "Nintendo Store";

export const NINTENDO_STORE_AUTHORIZATION_URL =
  NINTENDO_ACCOUNT_AUTHORIZATION_URL;
export const NINTENDO_STORE_SESSION_TOKEN_URL =
  NINTENDO_ACCOUNT_SESSION_TOKEN_URL;
export const NINTENDO_STORE_TOKEN_URL = NINTENDO_ACCOUNT_TOKEN_URL;
export const NINTENDO_STORE_PROFILE_URL = NINTENDO_ACCOUNT_PROFILE_URL;
const NINTENDO_STORE_REDIRECT_URI = "npf5c38e31cd085304b://auth";
export const NINTENDO_STORE_USER_AGENT =
  "com.nintendo.znej/1.13.0 (Android/7.1.2)";

type NintendoStoreProviderState = NintendoAccountProviderState;
type NintendoStoreSessionToken = NintendoAccountSessionToken;
type NintendoStoreToken = NintendoAccountToken;
type NintendoStoreLocale = NintendoAccountProfile;

export function createNintendoStoreProviderState(): NintendoStoreProviderState {
  return createNintendoAccountProviderState();
}

export function parseNintendoStoreProviderState(
  providerState: string,
): NintendoStoreProviderState {
  return parseNintendoAccountProviderState(providerState);
}

export function buildNintendoStoreAuthorizationUrl(args: {
  readonly clientId: string;
  readonly grant: ConnectorExternalCodeGrantConfig;
  readonly providerState: NintendoStoreProviderState;
}): string {
  return buildNintendoAccountAuthorizationUrl({
    ...args,
    redirectUri: NINTENDO_STORE_REDIRECT_URI,
  });
}

export function parseNintendoStoreSessionTokenCode(args: {
  readonly code: string;
  readonly expectedState: string;
}): string {
  return parseNintendoAccountSessionTokenCode({
    ...args,
    providerLabel: NINTENDO_STORE_PROVIDER_LABEL,
  });
}

export function exchangeNintendoStoreSessionTokenCode(args: {
  readonly clientId: string;
  readonly sessionTokenCode: string;
  readonly codeVerifier: string;
  readonly signal: AbortSignal;
}): Promise<NintendoStoreSessionToken> {
  return exchangeNintendoAccountSessionTokenCode({
    ...args,
    userAgent: NINTENDO_STORE_USER_AGENT,
    providerLabel: NINTENDO_STORE_PROVIDER_LABEL,
  });
}

export function exchangeNintendoStoreSessionToken(args: {
  readonly clientId: string;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}): Promise<NintendoStoreToken> {
  return exchangeNintendoAccountSessionToken({
    ...args,
    userAgent: NINTENDO_STORE_USER_AGENT,
    providerLabel: NINTENDO_STORE_PROVIDER_LABEL,
  });
}

export function fetchNintendoStoreLocale(args: {
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<NintendoStoreLocale> {
  return fetchNintendoAccountProfile({
    ...args,
    userAgent: NINTENDO_STORE_USER_AGENT,
    providerLabel: NINTENDO_STORE_PROVIDER_LABEL,
  });
}

export function nintendoStoreUserInfo(
  idToken: string,
): ConnectorAuthProviderGrantUserInfo {
  return nintendoAccountUserInfo(idToken, NINTENDO_STORE_PROVIDER_LABEL);
}

export function nintendoStoreAccountId(idToken: string): string {
  return nintendoAccountId(idToken, NINTENDO_STORE_PROVIDER_LABEL);
}
