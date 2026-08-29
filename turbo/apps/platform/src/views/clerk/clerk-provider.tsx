import { ClerkProvider as BaseClerkProvider } from "@clerk/react";
import type { BrowserClerk } from "@clerk/shared/types";
import { useGet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clerkLocalizations$ } from "../../i18n/clerk-localization.ts";
import { resolveClerkPublishableKey } from "../../lib/clerk-bootstrap.ts";
import { locale$ } from "../../signals/locale.ts";
import {
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAuthBrandContext,
  resolveAppAuthUrl,
  resolveAppUrl,
  resolveClerkSatelliteConfig,
} from "../../signals/auth.ts";
import { getClerkLocalization } from "../auth/clerk-localization.ts";
import { getClerkAppearance } from "./clerk-appearance.ts";

interface ClerkProviderProps {
  readonly children: ReactNode;
  readonly clerk: BrowserClerk;
}

export function VM0ClerkProvider({ children, clerk }: ClerkProviderProps) {
  const { t } = useTranslation();
  const clerkLocalizations = useGet(clerkLocalizations$);
  const locale = useGet(locale$);
  const clerkBrandName = resolveAuthBrandContext().brandName;

  const publishableKey = resolveClerkPublishableKey();
  const appUrl = resolveAppUrl();
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();
  const satelliteConfig = resolveClerkSatelliteConfig();

  const providerProps = {
    Clerk: clerk,
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
  };
  return satelliteConfig ? (
    <BaseClerkProvider {...providerProps} {...satelliteConfig}>
      {children}
    </BaseClerkProvider>
  ) : (
    <BaseClerkProvider {...providerProps}>{children}</BaseClerkProvider>
  );
}
