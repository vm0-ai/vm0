import {
  ClerkProvider as BaseClerkProvider,
  type ClerkProviderProps as BaseClerkProviderProps,
} from "@clerk/react";
import { useGet } from "ccstate-react";
import type { ReactNode } from "react";
import { resolvePlatformRuntimeConfig } from "../../lib/platform-host.ts";
import { brandName$ } from "../../signals/branding.ts";
import {
  clerkInstance$,
  clerkUi$,
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAppAuthUrl,
  resolveAppUrl,
  resolveClerkSatelliteConfig,
} from "../../signals/auth.ts";
import { getClerkLocalization } from "../auth/clerk-localization.ts";
import { getClerkAppearance } from "./clerk-appearance.ts";

interface ClerkProviderProps {
  children: ReactNode;
}

export function VM0ClerkProvider({ children }: ClerkProviderProps) {
  const clerkInstance = useGet(clerkInstance$);
  const clerkUi = useGet(clerkUi$);
  const brandName = useGet(brandName$);

  const publishableKey = resolvePlatformRuntimeConfig().clerkPublishableKey;
  const appUrl = resolveAppUrl();
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();
  const satelliteConfig = resolveClerkSatelliteConfig();

  const providerProps = {
    Clerk: clerkInstance as unknown as BaseClerkProviderProps["Clerk"],
    afterSignOutUrl: resolveAppAuthUrl("/sign-in"),
    allowedRedirectOrigins,
    appearance: getClerkAppearance(),
    localization: getClerkLocalization(brandName),
    publishableKey,
    signInFallbackRedirectUrl: appUrl,
    signInUrl: resolveAppAuthUrl("/sign-in"),
    signUpFallbackRedirectUrl: appUrl,
    signUpUrl: resolveAppAuthUrl("/sign-up"),
    ui: clerkUi,
  };
  return satelliteConfig ? (
    <BaseClerkProvider {...providerProps} {...satelliteConfig}>
      {children}
    </BaseClerkProvider>
  ) : (
    <BaseClerkProvider {...providerProps}>{children}</BaseClerkProvider>
  );
}
