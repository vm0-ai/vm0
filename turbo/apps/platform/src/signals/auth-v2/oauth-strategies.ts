import type { OAuthStrategy } from "@clerk/react/types";

export const AUTH_V2_OAUTH_STRATEGIES = [
  "oauth_apple",
  "oauth_google",
] as const satisfies readonly OAuthStrategy[];

export type AuthV2OAuthStrategy = (typeof AUTH_V2_OAUTH_STRATEGIES)[number];

export function isAuthV2OAuthStrategy(
  strategy: string,
): strategy is AuthV2OAuthStrategy {
  return strategy === "oauth_apple" || strategy === "oauth_google";
}

export function enabledAuthV2OAuthStrategies(
  strategies: readonly OAuthStrategy[] | undefined,
): readonly AuthV2OAuthStrategy[] {
  if (!strategies) {
    return [];
  }
  return AUTH_V2_OAUTH_STRATEGIES.filter((strategy) => {
    return strategies.includes(strategy);
  });
}
