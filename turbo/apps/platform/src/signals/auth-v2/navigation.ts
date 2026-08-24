import { ROUTES } from "../route-paths.ts";

export type AuthV2RouteMode = "sign-in" | "sign-up";
export type AuthV2StepPath = `/${string}`;

export interface AuthV2Navigation {
  readonly completionRedirectUrl: string;
  readonly href: (
    targetMode: AuthV2RouteMode,
    stepPath?: AuthV2StepPath,
  ) => string;
}

const AUTH_V2_ROUTE_BY_MODE = {
  "sign-in": ROUTES.signInV2,
  "sign-up": ROUTES.signUpV2,
} as const satisfies Record<AuthV2RouteMode, string>;

function preserveHashWithRedirect(
  authHash: string,
  completionRedirectUrl: string,
): string {
  const hashQueryIndex = authHash.indexOf("?");
  if (hashQueryIndex === -1) {
    return authHash;
  }

  const hashParams = new URLSearchParams(authHash.slice(hashQueryIndex + 1));
  if (!hashParams.has("redirect_url")) {
    return authHash;
  }

  hashParams.set("redirect_url", completionRedirectUrl);
  return `${authHash.slice(0, hashQueryIndex + 1)}${hashParams.toString()}`;
}

export function createAuthV2Navigation(
  completionRedirectUrl: string,
  authSearch: string,
  authHash: string,
): AuthV2Navigation {
  const searchParams = new URLSearchParams(authSearch);
  searchParams.set("redirect_url", completionRedirectUrl);
  const search = searchParams.toString();
  const hash = preserveHashWithRedirect(authHash, completionRedirectUrl);

  return {
    completionRedirectUrl,
    href: (targetMode: AuthV2RouteMode, stepPath?: AuthV2StepPath): string => {
      const pathname = `${AUTH_V2_ROUTE_BY_MODE[targetMode]}${stepPath ?? ""}`;
      return `${pathname}?${search}${hash}`;
    },
  };
}
