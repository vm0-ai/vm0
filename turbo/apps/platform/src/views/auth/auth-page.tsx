import { GoogleOneTap, SignIn, SignUp } from "@clerk/react";
import type { BrowserClerk } from "@clerk/shared/types";
import { Loader2 } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { activeRoute$ } from "../../signals/active-route.ts";
import {
  buildSignInRedirectUrl,
  buildSignupRedirectUrl,
  resolveAuthBrandContext,
} from "../../signals/auth.ts";
import { authPageMountRef$ } from "../../signals/auth-page-mount.ts";
import { theme$ } from "../../signals/theme.ts";
import { AuthLayout } from "./auth-layout.tsx";
import { getClerkAppearance } from "./auth-clerk-appearance.ts";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";

export type AuthPageMode = "sign-in" | "sign-up";

interface AuthPageProps {
  readonly clerk: BrowserClerk;
  readonly mode: AuthPageMode;
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

function AuthPageContent({ mode }: Pick<AuthPageProps, "mode">) {
  const authPageMountRef = useSet(authPageMountRef$);
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
        {activeRoute === "signIn" && (
          <GoogleOneTap
            signInForceRedirectUrl={redirectUrl}
            signUpForceRedirectUrl={redirectUrl}
          />
        )}
        <AuthLayout authBrand={authBrand}>
          <div
            className="relative z-10 flex w-full max-w-md flex-col gap-3"
            data-testid="app-sign-in"
            ref={authPageMountRef}
          >
            <SignIn
              appearance={getClerkAppearance(theme, authBrand.brandName)}
              fallback={<AuthLoadingFallback />}
              fallbackRedirectUrl={redirectUrl}
              forceRedirectUrl={redirectUrl}
              path="/sign-in"
              routing="path"
            />
          </div>
        </AuthLayout>
      </>
    );
  }

  const redirectUrl = buildSignupRedirectUrl(
    location.search,
    undefined,
    location.hash,
  );

  return (
    <AuthLayout authBrand={authBrand}>
      <div data-testid="app-sign-up" ref={authPageMountRef}>
        <SignUp
          appearance={getClerkAppearance(theme, authBrand.brandName)}
          fallback={<AuthLoadingFallback />}
          fallbackRedirectUrl={redirectUrl}
          forceRedirectUrl={redirectUrl}
          path="/sign-up"
          routing="path"
        />
      </div>
    </AuthLayout>
  );
}

export function AuthPage({ clerk, mode }: AuthPageProps) {
  return (
    <VM0ClerkProvider clerk={clerk}>
      <AuthPageContent mode={mode} />
    </VM0ClerkProvider>
  );
}
