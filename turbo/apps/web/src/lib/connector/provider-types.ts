import { type Env } from "../../env";

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number; // seconds until access token expires
  scopes: string[];
  userInfo: { id: string; username: string | null; email: string | null };
}

export interface ProviderHandler {
  buildAuthUrl(
    clientId: string,
    redirectUri: string,
    state: string,
  ): string | Promise<string>;
  exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
    state?: string,
  ): Promise<OAuthTokenResult>;
  getClientId(currentEnv: Env): string | undefined;
  getClientSecret(currentEnv: Env): string | undefined;
  getSecretName(): string;
  getRefreshSecretName?(): string;
}
