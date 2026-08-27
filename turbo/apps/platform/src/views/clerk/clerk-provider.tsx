import {
  ClerkProvider as BaseClerkProvider,
  type ClerkProviderProps as BaseClerkProviderProps,
} from "@clerk/react";
import { useGet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clerkLocalizations$ } from "../../i18n/clerk-localization.ts";
import { resolvePlatformRuntimeConfig } from "../../lib/platform-host.ts";
import { brandName$ } from "../../signals/branding.ts";
import { locale$ } from "../../signals/locale.ts";
import {
  clerkInstance$,
  clerkUi$,
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAuthBrandContext,
  resolveAppAuthUrl,
  resolveAppUrl,
  resolveClerkSatelliteConfig,
} from "../../signals/auth.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { getClerkLocalization } from "../auth/clerk-localization.ts";
import { getClerkAppearance } from "./clerk-appearance.ts";

interface ClerkProviderProps {
  children: ReactNode;
}

export function VM0ClerkProvider({ children }: ClerkProviderProps) {
  const { t } = useTranslation();
  const clerkInstance = useGet(clerkInstance$);
  const clerkUi = useGet(clerkUi$);
  const domainBrandName = useGet(brandName$);
  const clerkLocalizations = useGet(clerkLocalizations$);
  const locale = useGet(locale$);
  const isAuthPage =
    location.pathname === ROUTES.signIn ||
    location.pathname.startsWith(`${ROUTES.signIn}/`) ||
    location.pathname === ROUTES.signUp ||
    location.pathname.startsWith(`${ROUTES.signUp}/`) ||
    location.pathname === ROUTES.signInV2 ||
    location.pathname.startsWith(`${ROUTES.signInV2}/`) ||
    location.pathname === ROUTES.signUpV2 ||
    location.pathname.startsWith(`${ROUTES.signUpV2}/`);
  const clerkBrandName = isAuthPage
    ? resolveAuthBrandContext().brandName
    : domainBrandName;

  const publishableKey = resolvePlatformRuntimeConfig().clerkPublishableKey;
  const appUrl = resolveAppUrl();
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();
  const satelliteConfig = resolveClerkSatelliteConfig();

  const providerProps = {
    Clerk: clerkInstance as unknown as BaseClerkProviderProps["Clerk"],
    afterSignOutUrl: resolveAppAuthUrl("/sign-in"),
    allowedRedirectOrigins,
    appearance: getClerkAppearance(),
    localization: getClerkLocalization(
      clerkBrandName,
      locale,
      clerkLocalizations,
      t,
    ),
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
