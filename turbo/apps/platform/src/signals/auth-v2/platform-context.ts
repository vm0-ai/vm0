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

export function resolveAuthV2PlatformContext(
  mode: AuthV2RouteMode,
): AuthV2PlatformContext {
  const authSearch = location.search;
  const authHash = location.hash;
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();
  const completionRedirectUrl =
    mode === "sign-in"
      ? buildSignInRedirectUrl(authSearch, allowedRedirectOrigins, authHash)
      : buildSignupRedirectUrl(authSearch, allowedRedirectOrigins, authHash);

  return {
    authBrand: resolveAuthBrandContext(
      authSearch,
      authHash,
      allowedRedirectOrigins,
    ),
    navigation: createAuthV2Navigation(
      completionRedirectUrl,
      authSearch,
      authHash,
    ),
    satelliteConfig: resolveClerkSatelliteConfig(),
  };
}
