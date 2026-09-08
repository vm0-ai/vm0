import { GoogleOneTap, SignIn, SignUp } from "@clerk/react";
import type { BrowserClerk } from "@clerk/shared/types";
import type { ui } from "@clerk/ui";
import { Loader2 } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { activeRoute$ } from "../../signals/active-route.ts";
import {
  buildSignInRedirectUrl,
  buildSignupRedirectUrl,
  resolveAuthBrandContext,
} from "../../signals/auth.ts";
import { authV1PageMountRef$ } from "../../signals/auth-v1-page-mount.ts";
import { theme$ } from "../../signals/theme.ts";
import { AuthV1Layout } from "./auth-v1-layout.tsx";
import { AuthV1ClerkProvider } from "./clerk-provider.tsx";
import { getAuthV1ComponentAppearance } from "./component-appearance.ts";

export type AuthV1PageMode = "sign-in" | "sign-up";

interface AuthV1PageProps {
  readonly clerk: BrowserClerk;
  readonly mode: AuthV1PageMode;
  readonly ui: typeof ui;
}

function AuthLoadingFallback() {
  const { t } = useTranslation();
  return (
    <div
      className="flex w-full max-w-md items-center justify-center py-16 text-muted-foreground"
      data-testid="clerk-auth-loading"
      role="status"
    >
      <Loader2 className="animate-spin" size={20} aria-hidden="true" />
      <span className="sr-only">
        {t(($) => {
          return $.auth.loading;
        })}
      </span>
    </div>
  );
}

function AuthV1PageContent({ mode }: Pick<AuthV1PageProps, "mode">) {
  const authPageMountRef = useSet(authV1PageMountRef$);
  const activeRoute = useGet(activeRoute$);
  const theme = useGet(theme$);
  const authBrand = resolveAuthBrandContext();

  if (mode === "sign-in") {
    const redirectUrl = buildSignInRedirectUrl(
      location.search,
      undefined,
      location.hash,
    );

    return (
      <>
        {activeRoute === "signInV1" && (
          <GoogleOneTap
            signInForceRedirectUrl={redirectUrl}
            signUpForceRedirectUrl={redirectUrl}
          />
        )}
        <AuthV1Layout authBrand={authBrand}>
          <div
            className="relative z-10 flex w-[var(--okou-auth-card-page-width)] max-w-[var(--okou-auth-card-max-width)] shrink-0 flex-col gap-3"
            data-testid="app-sign-in"
            ref={authPageMountRef}
          >
            <SignIn
              appearance={getAuthV1ComponentAppearance(
                theme,
                authBrand,
                location.origin,
                mode,
              )}
              fallback={<AuthLoadingFallback />}
              fallbackRedirectUrl={redirectUrl}
              forceRedirectUrl={redirectUrl}
              path="/v1/sign-in"
              routing="path"
              signInUrl="/v1/sign-in"
              signUpUrl="/v1/sign-up"
            />
          </div>
        </AuthV1Layout>
      </>
    );
  }

  const redirectUrl = buildSignupRedirectUrl(
    location.search,
    undefined,
    location.hash,
  );

  return (
    <AuthV1Layout authBrand={authBrand}>
      <div
        className="relative z-10 flex w-[var(--okou-auth-card-page-width)] max-w-[var(--okou-auth-card-max-width)] shrink-0 flex-col gap-3"
        data-testid="app-sign-up"
        ref={authPageMountRef}
      >
        <SignUp
          appearance={getAuthV1ComponentAppearance(
            theme,
            authBrand,
            location.origin,
            mode,
          )}
          fallback={<AuthLoadingFallback />}
          fallbackRedirectUrl={redirectUrl}
          forceRedirectUrl={redirectUrl}
          path="/v1/sign-up"
          routing="path"
          signInUrl="/v1/sign-in"
        />
      </div>
    </AuthV1Layout>
  );
}

export function AuthV1Page({ clerk, mode, ui }: AuthV1PageProps) {
  return (
    <AuthV1ClerkProvider clerk={clerk} mode={mode} ui={ui}>
      <AuthV1PageContent mode={mode} />
    </AuthV1ClerkProvider>
  );
}
