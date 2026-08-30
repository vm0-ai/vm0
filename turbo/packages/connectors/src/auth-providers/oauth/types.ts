export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
  readonly scopes: readonly string[] | null;
}

export function oauthRefreshResultToProviderResult(
  result: OAuthRefreshResult,
): {
  readonly outputs: {
    readonly accessToken: string;
    readonly refreshToken?: string;
  };
  readonly expiresIn?: number;
  readonly scopes?: readonly string[];
} {
  return {
    outputs: {
      accessToken: result.accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    },
    ...(result.expiresIn === undefined ? {} : { expiresIn: result.expiresIn }),
    ...(result.scopes === null ? {} : { scopes: result.scopes }),
  };
}
