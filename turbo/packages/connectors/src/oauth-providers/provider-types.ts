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
  codeVerifier?: string;
  oauthContext?: string;
}

export interface OAuthAuthorizeArgs {
  readonly clientId?: string;
  readonly redirectUri: string;
  readonly state: string;
}

export interface OAuthExchangeArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeVerifier?: string;
  readonly oauthContext?: string;
}

export interface OAuthRefreshArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
}

export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
}

export interface ProviderHandler {
  buildAuthUrl(
    clientId: string,
    redirectUri: string,
    state: string,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  buildAuthUrlWithArgs?(
    args: OAuthAuthorizeArgs,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
    state?: string,
    codeVerifier?: string,
  ): Promise<OAuthTokenResult>;
  exchangeCodeWithArgs?(args: OAuthExchangeArgs): Promise<OAuthTokenResult>;
  getClientId(currentEnv: ProviderEnv): string | undefined;
  getClientSecret(currentEnv: ProviderEnv): string | undefined;
  getSecretName(): string;
  getRefreshSecretName?(): string;
  refreshToken?(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<OAuthRefreshResult>;
  refreshTokenWithArgs?(args: OAuthRefreshArgs): Promise<OAuthRefreshResult>;
  revokeToken?(
    clientId: string,
    clientSecret: string,
    accessToken: string,
  ): Promise<void>;
}

export async function buildProviderAuthUrl(
  handler: ProviderHandler,
  args: OAuthAuthorizeArgs,
): Promise<string | AuthUrlResult> {
  if (handler.buildAuthUrlWithArgs) {
    return await handler.buildAuthUrlWithArgs(args);
  }
  if (!args.clientId) {
    throw new Error("OAuth provider handler requires a client ID");
  }
  return await handler.buildAuthUrl(
    args.clientId,
    args.redirectUri,
    args.state,
  );
}

export async function exchangeProviderCode(
  handler: ProviderHandler,
  args: OAuthExchangeArgs,
): Promise<OAuthTokenResult> {
  if (handler.exchangeCodeWithArgs) {
    return await handler.exchangeCodeWithArgs(args);
  }
  if (!args.clientId || !args.clientSecret) {
    throw new Error("OAuth provider handler requires client credentials");
  }
  return await handler.exchangeCode(
    args.clientId,
    args.clientSecret,
    args.code,
    args.redirectUri,
    args.state,
    args.codeVerifier,
  );
}

export async function refreshProviderToken(
  handler: ProviderHandler,
  args: OAuthRefreshArgs,
): Promise<OAuthRefreshResult> {
  if (handler.refreshTokenWithArgs) {
    return await handler.refreshTokenWithArgs(args);
  }
  if (!handler.refreshToken) {
    throw new Error("OAuth provider handler does not support token refresh");
  }
  if (!args.clientId || !args.clientSecret) {
    throw new Error("OAuth provider handler requires client credentials");
  }
  return await handler.refreshToken(
    args.clientId,
    args.clientSecret,
    args.refreshToken,
  );
}
