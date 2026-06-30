import { SignIn, SignUp } from "@clerk/clerk-react";
import { useGet } from "ccstate-react";
import {
  buildSignInRedirectUrl,
  buildSignupRedirectUrl,
} from "../../signals/auth.ts";
import { theme$ } from "../../signals/theme.ts";
import { AuthLayout } from "./auth-layout.tsx";
import { getClerkAppearance } from "./auth-clerk-appearance.ts";

export type AuthPageMode = "sign-in" | "sign-up";

interface AuthPageProps {
  mode: AuthPageMode;
}

export function AuthPage({ mode }: AuthPageProps) {
  const theme = useGet(theme$);

  if (mode === "sign-in") {
    const redirectUrl = buildSignInRedirectUrl(location.search);

    return (
      <AuthLayout>
        <div
          className="relative z-10 flex w-full max-w-md flex-col gap-3"
          data-testid="app-sign-in"
        >
          <SignIn
            appearance={getClerkAppearance(theme)}
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
      <div data-testid="app-sign-up">
        <SignUp
          appearance={getClerkAppearance(theme)}
          fallbackRedirectUrl={redirectUrl}
          forceRedirectUrl={redirectUrl}
          path="/sign-up"
          routing="path"
        />
      </div>
    </AuthLayout>
  );
}
