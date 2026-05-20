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

export type BuildAuthUrlFn = (
  args: OAuthAuthorizeArgs,
) => string | AuthUrlResult | Promise<string | AuthUrlResult>;

export type ExchangeCodeFn = (
  args: OAuthExchangeArgs,
) => Promise<OAuthTokenResult>;

export type RefreshTokenFn = (
  args: OAuthRefreshArgs,
) => Promise<OAuthRefreshResult>;

export interface OAuthRevokeArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly accessToken: string;
}

export type RevokeTokenFn = (args: OAuthRevokeArgs) => Promise<void>;

export function requireOAuthClientId(args: {
  readonly clientId?: string;
}): string {
  if (!args.clientId) {
    throw new Error("OAuth provider requires a client ID");
  }
  return args.clientId;
}

export function requireOAuthClientCredentials(args: {
  readonly clientId?: string;
  readonly clientSecret?: string;
}): { readonly clientId: string; readonly clientSecret: string } {
  if (!args.clientId || !args.clientSecret) {
    throw new Error("OAuth provider requires client credentials");
  }
  return { clientId: args.clientId, clientSecret: args.clientSecret };
}

export interface OAuthProvider {
  getClientId(currentEnv: ProviderEnv): string | undefined;
  getClientSecret(currentEnv: ProviderEnv): string | undefined;
  getSecretName(): string;
}

export type OAuthAuthorizationCodeProvider = OAuthProvider & {
  buildAuthUrl: BuildAuthUrlFn;
  exchangeCode: ExchangeCodeFn;
};

export type OAuthRefreshProvider = OAuthProvider & {
  getRefreshSecretName(): string;
  refreshToken: RefreshTokenFn;
};

export type OAuthRevocationProvider = OAuthProvider & {
  revokeToken: RevokeTokenFn;
};

type OAuthNoRefreshProvider = {
  getRefreshSecretName?: never;
  refreshToken?: never;
};

type OAuthNoRevocationProvider = {
  revokeToken?: never;
};

export type OAuthConnectorProvider = OAuthAuthorizationCodeProvider &
  (OAuthRefreshProvider | OAuthNoRefreshProvider) &
  (OAuthRevocationProvider | OAuthNoRevocationProvider);

export function isOAuthRefreshProvider(
  provider: OAuthProvider,
): provider is OAuthRefreshProvider {
  return (
    "getRefreshSecretName" in provider &&
    typeof provider.getRefreshSecretName === "function" &&
    "refreshToken" in provider &&
    typeof provider.refreshToken === "function"
  );
}
