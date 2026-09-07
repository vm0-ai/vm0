import { ClerkProvider as BaseClerkProvider } from "@clerk/react";
import type { BrowserClerk } from "@clerk/shared/types";
import { useGet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clerkLocalizations$ } from "../../i18n/clerk-localization.ts";
import { resolvePlatformRuntimeConfig } from "../../lib/platform-host.ts";
import { locale$ } from "../../signals/locale.ts";
import {
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAuthBrandContext,
  resolveAppAuthUrl,
  resolveAppUrl,
  resolveClerkSatelliteConfig,
} from "../../signals/auth.ts";
import { getClerkLocalization } from "./clerk-localization.ts";
import { getAuthV1ProviderAppearance } from "./provider-appearance.ts";

interface ClerkProviderProps {
  readonly children: ReactNode;
  readonly clerk: BrowserClerk;
  readonly mode: "sign-in" | "sign-up";
}

export function AuthV1ClerkProvider({
  children,
  clerk,
  mode,
}: ClerkProviderProps) {
  const { t } = useTranslation();
  const clerkLocalizations = useGet(clerkLocalizations$);
  const locale = useGet(locale$);
  const clerkBrandName = resolveAuthBrandContext().brandName;

  const publishableKey = resolvePlatformRuntimeConfig().clerkPublishableKey;
  const appUrl = resolveAppUrl();
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();
  const satelliteConfig = resolveClerkSatelliteConfig();

  const providerProps = {
    Clerk: clerk,
    afterSignOutUrl: resolveAppAuthUrl("/v1/sign-in"),
    allowedRedirectOrigins,
    appearance: getAuthV1ProviderAppearance(),
    localization: getClerkLocalization(
      mode,
      clerkBrandName,
      locale,
      clerkLocalizations,
      t,
    ),
    publishableKey,
    signInFallbackRedirectUrl: appUrl,
    signInUrl: resolveAppAuthUrl("/v1/sign-in"),
    signUpFallbackRedirectUrl: appUrl,
    signUpUrl: resolveAppAuthUrl("/v1/sign-up"),
  };
  return satelliteConfig ? (
    <BaseClerkProvider {...providerProps} {...satelliteConfig}>
      {children}
    </BaseClerkProvider>
  ) : (
    <BaseClerkProvider {...providerProps}>{children}</BaseClerkProvider>
  );
}
