import { SignIn, SignUp } from "@clerk/react";
import { IconLoader2 } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  buildSignInRedirectUrl,
  buildSignupRedirectUrl,
} from "../../signals/auth.ts";
import { authPageMountRef$ } from "../../signals/auth-page-mount.ts";
import { theme$ } from "../../signals/theme.ts";
import { AuthLayout } from "./auth-layout.tsx";
import { getClerkAppearance } from "./auth-clerk-appearance.ts";

export type AuthPageMode = "sign-in" | "sign-up";

interface AuthPageProps {
  mode: AuthPageMode;
}

function AuthLoadingFallback() {
  return (
    <div
      className="flex w-full max-w-md items-center justify-center py-16 text-muted-foreground"
      data-testid="clerk-auth-loading"
      role="status"
    >
      <IconLoader2 className="animate-spin" size={20} aria-hidden="true" />
      <span className="sr-only">Loading authentication</span>
    </div>
  );
}

export function AuthPage({ mode }: AuthPageProps) {
  const authPageMountRef = useSet(authPageMountRef$);
  const theme = useGet(theme$);

  if (mode === "sign-in") {
    const redirectUrl = buildSignInRedirectUrl(location.search);

    return (
      <AuthLayout>
        <div
          className="relative z-10 flex w-full max-w-md flex-col gap-3"
          data-testid="app-sign-in"
          ref={authPageMountRef}
        >
          <SignIn
            appearance={getClerkAppearance(theme)}
            fallback={<AuthLoadingFallback />}
            fallbackRedirectUrl={redirectUrl}
            forceRedirectUrl={redirectUrl}
            path="/sign-in"
            routing="path"
          />
        </div>
      </AuthLayout>
    );
  }

  const redirectUrl = buildSignupRedirectUrl(location.search);

  return (
    <AuthLayout>
      <div data-testid="app-sign-up" ref={authPageMountRef}>
        <SignUp
          appearance={getClerkAppearance(theme)}
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
