export interface ProviderEnv {
  readonly [name: string]: string | undefined;
}

export function providerEnvFromObject(values: object): ProviderEnv {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string" || !Object.hasOwn(values, property)) {
          return undefined;
        }
        const value = (values as Record<string, unknown>)[property];
        return typeof value === "string" ? value : undefined;
      },
    },
  ) as ProviderEnv;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number; // seconds until access token expires
  scopes: string[];
  userInfo: { id: string; username: string | null; email: string | null };
}

/**
 * Result from buildAuthUrl when PKCE is required.
 * Providers that need PKCE return { url, codeVerifier } instead of a plain string.
 */
export interface AuthUrlResult {
  url: string;
  codeVerifier: string;
}

export interface ProviderHandler {
  buildAuthUrl(
    clientId: string,
    redirectUri: string,
    state: string,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
    state?: string,
    codeVerifier?: string,
  ): Promise<OAuthTokenResult>;
  getClientId(currentEnv: ProviderEnv): string | undefined;
  getClientSecret(currentEnv: ProviderEnv): string | undefined;
  getSecretName(): string;
  getRefreshSecretName?(): string;
  refreshToken?(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresIn?: number;
  }>;
  revokeToken?(
    clientId: string,
    clientSecret: string,
    accessToken: string,
  ): Promise<void>;
}
