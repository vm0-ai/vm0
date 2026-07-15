import {
  ClerkProvider as BaseClerkProvider,
  GoogleOneTap,
  type ClerkProviderProps as BaseClerkProviderProps,
} from "@clerk/clerk-react";
import { useLoadable } from "ccstate-react";
import type { ReactNode } from "react";
import {
  clerk$,
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAppAuthUrl,
  resolveAppUrl,
} from "../../signals/auth.ts";
import { getVm0ClerkLocalization } from "../auth/clerk-localization.ts";
import { getClerkAppearance } from "./clerk-appearance.ts";

interface ClerkProviderProps {
  children: ReactNode;
}

export function VM0ClerkProvider({ children }: ClerkProviderProps) {
  const clerkLoadable = useLoadable(clerk$);

  if (clerkLoadable.state !== "hasData") {
    return null;
  }

  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
  const appUrl = resolveAppUrl();
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();

  return (
    <BaseClerkProvider
      Clerk={clerkLoadable.data as unknown as BaseClerkProviderProps["Clerk"]}
      publishableKey={publishableKey}
      appearance={getClerkAppearance()}
      signInUrl={resolveAppAuthUrl("/sign-in")}
      signUpUrl={resolveAppAuthUrl("/sign-up")}
      signInFallbackRedirectUrl={appUrl}
      signUpFallbackRedirectUrl={appUrl}
      allowedRedirectOrigins={allowedRedirectOrigins}
      localization={getVm0ClerkLocalization()}
    >
      <GoogleOneTap
        signInForceRedirectUrl={appUrl}
        signUpForceRedirectUrl={appUrl}
      />
      {children}
    </BaseClerkProvider>
  );
}
