export interface SoFrontendRewriteEnv {
  readonly PAID_ONBOARDING_URL?: string;
  readonly NEXT_PUBLIC_PAID_ONBOARDING_URL?: string;
  readonly VERCEL_ENV?: string;
}

export interface SoFrontendRewrite {
  readonly source: string;
  readonly destination: string;
}

export function resolveSoFrontendUrl(
  env: SoFrontendRewriteEnv,
): string | undefined;

export function matchesSoFrontendRewritePath(pathname: string): boolean;

export function buildSoFrontendRewrites(
  env: SoFrontendRewriteEnv,
): SoFrontendRewrite[];
