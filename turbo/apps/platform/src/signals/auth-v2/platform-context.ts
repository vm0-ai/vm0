import {
  buildSignInRedirectUrl,
  buildSignupRedirectUrl,
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAuthBrandContext,
  resolveClerkSatelliteConfig,
  type AuthBrandContext,
} from "../auth.ts";
import {
  createAuthV2Navigation,
  type AuthV2Navigation,
  type AuthV2RouteMode,
} from "./navigation.ts";

export type AuthV2SatelliteConfig = ReturnType<
  typeof resolveClerkSatelliteConfig
>;

export interface AuthV2PlatformContext {
  readonly authBrand: AuthBrandContext;
  readonly navigation: AuthV2Navigation;
  readonly satelliteConfig: AuthV2SatelliteConfig;
}

interface ResolveAuthV2PlatformContextOptions {
  readonly authHash?: string;
  readonly authSearch?: string;
}

export function resolveAuthV2PlatformContext(
  mode: AuthV2RouteMode,
  options: ResolveAuthV2PlatformContextOptions = {},
): AuthV2PlatformContext {
  const authSearch = options.authSearch ?? location.search;
  const authHash = options.authHash ?? location.hash;
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();
  const signUpCompletionRedirectUrl = buildSignupRedirectUrl(
    authSearch,
    allowedRedirectOrigins,
    authHash,
  );
  const completionRedirectUrl =
    mode === "sign-in"
      ? buildSignInRedirectUrl(authSearch, allowedRedirectOrigins, authHash)
      : signUpCompletionRedirectUrl;

  return {
    authBrand: resolveAuthBrandContext(
      authSearch,
      authHash,
      allowedRedirectOrigins,
    ),
    navigation: createAuthV2Navigation({
      authHash,
      authSearch,
      completionRedirectUrl,
      mode,
      signUpCompletionRedirectUrl,
    }),
    satelliteConfig: resolveClerkSatelliteConfig(),
  };
}
