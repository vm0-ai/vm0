export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
}

export function oauthRefreshResultToProviderResult(
  result: OAuthRefreshResult,
): {
  readonly outputs: {
    readonly accessToken: string;
    readonly refreshToken?: string;
  };
  readonly expiresIn?: number;
} {
  return {
    outputs: {
      accessToken: result.accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    },
    ...(result.expiresIn === undefined ? {} : { expiresIn: result.expiresIn }),
  };
}
