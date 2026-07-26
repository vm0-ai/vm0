import {
  ClerkProvider as BaseClerkProvider,
  GoogleOneTap,
  type ClerkProviderProps as BaseClerkProviderProps,
} from "@clerk/react";
import { useLoadable } from "ccstate-react";
import type { ReactNode } from "react";
import { resolvePlatformRuntimeConfig } from "../../lib/platform-host.ts";
import {
  clerk$,
  clerkUi$,
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAppAuthUrl,
  resolveAppUrl,
  resolveClerkSatelliteConfig,
} from "../../signals/auth.ts";
import { getVm0ClerkLocalization } from "../auth/clerk-localization.ts";
import { getClerkAppearance } from "./clerk-appearance.ts";

interface ClerkProviderProps {
  children: ReactNode;
}

export function VM0ClerkProvider({ children }: ClerkProviderProps) {
  const clerkLoadable = useLoadable(clerk$);
  const clerkUiLoadable = useLoadable(clerkUi$);

  if (
    clerkLoadable.state !== "hasData" ||
    clerkUiLoadable.state !== "hasData"
  ) {
    return null;
  }

  const publishableKey = resolvePlatformRuntimeConfig().clerkPublishableKey;
  const appUrl = resolveAppUrl();
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();
  const satelliteConfig = resolveClerkSatelliteConfig();

  const providerProps = {
    Clerk: clerkLoadable.data as unknown as BaseClerkProviderProps["Clerk"],
    allowedRedirectOrigins,
    appearance: getClerkAppearance(),
    localization: getVm0ClerkLocalization(),
    publishableKey,
    signInFallbackRedirectUrl: appUrl,
    signInUrl: resolveAppAuthUrl("/sign-in"),
    signUpFallbackRedirectUrl: appUrl,
    signUpUrl: resolveAppAuthUrl("/sign-up"),
    ui: clerkUiLoadable.data,
  };
  const providerChildren = (
    <>
      <GoogleOneTap
        signInForceRedirectUrl={appUrl}
        signUpForceRedirectUrl={appUrl}
      />
      {children}
    </>
  );

  return satelliteConfig ? (
    <BaseClerkProvider {...providerProps} {...satelliteConfig}>
      {providerChildren}
    </BaseClerkProvider>
  ) : (
    <BaseClerkProvider {...providerProps}>{providerChildren}</BaseClerkProvider>
  );
}
