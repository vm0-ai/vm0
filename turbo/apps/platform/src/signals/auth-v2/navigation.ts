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

interface CreateAuthV2NavigationOptions {
  readonly authHash: string;
  readonly authSearch: string;
  readonly completionRedirectUrl: string;
  readonly mode: AuthV2RouteMode;
  readonly signUpCompletionRedirectUrl: string;
}

const AUTH_V2_ROUTE_BY_MODE = {
  "sign-in": ROUTES.signIn,
  "sign-up": ROUTES.signUp,
} as const satisfies Record<AuthV2RouteMode, string>;

function preserveHashWithRedirect(
  authHash: string,
  completionRedirectUrl: string | null,
): string {
  const hashQueryIndex = authHash.indexOf("?");
  if (hashQueryIndex === -1) {
    return authHash;
  }

  const hashParams = new URLSearchParams(authHash.slice(hashQueryIndex + 1));
  if (!hashParams.has("redirect_url")) {
    return authHash;
  }

  if (completionRedirectUrl === null) {
    hashParams.delete("redirect_url");
  } else {
    hashParams.set("redirect_url", completionRedirectUrl);
  }

  const hashSearch = hashParams.toString();
  const hashPath = authHash.slice(0, hashQueryIndex);
  return hashSearch ? `${hashPath}?${hashSearch}` : hashPath;
}

function resolveNavigationRedirectUrl(
  options: CreateAuthV2NavigationOptions,
  targetMode: AuthV2RouteMode,
): string | null {
  if (options.mode === "sign-up" || targetMode === "sign-up") {
    return options.signUpCompletionRedirectUrl;
  }

  return options.completionRedirectUrl === options.signUpCompletionRedirectUrl
    ? options.completionRedirectUrl
    : null;
}

export function createAuthV2Navigation(
  options: CreateAuthV2NavigationOptions,
): AuthV2Navigation {
  return {
    completionRedirectUrl: options.completionRedirectUrl,
    href: (targetMode: AuthV2RouteMode, stepPath?: AuthV2StepPath): string => {
      const navigationRedirectUrl = resolveNavigationRedirectUrl(
        options,
        targetMode,
      );
      const searchParams = new URLSearchParams(options.authSearch);
      if (navigationRedirectUrl === null) {
        searchParams.delete("redirect_url");
      } else {
        searchParams.set("redirect_url", navigationRedirectUrl);
      }

      const search = searchParams.toString();
      const hash = preserveHashWithRedirect(
        options.authHash,
        navigationRedirectUrl,
      );
      const pathname = `${AUTH_V2_ROUTE_BY_MODE[targetMode]}${stepPath ?? ""}`;
      return `${pathname}?${search}${hash}`;
    },
  };
}
