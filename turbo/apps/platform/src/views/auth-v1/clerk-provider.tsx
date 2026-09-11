import { ClerkProvider as BaseClerkProvider } from "@clerk/react";
import type { BrowserClerk } from "@clerk/shared/types";
import type { ui } from "@clerk/ui";
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import {
  clerkLocalizationForLocale,
  clerkLocalizations$,
} from "../../i18n/clerk-localization.ts";
import { resolvePlatformRuntimeConfig } from "../../lib/platform-host.ts";
import { locale$ } from "../../signals/locale.ts";
import type { AuthV1ClerkSignals } from "../../signals/auth-v1-clerk.ts";
import { theme$ } from "../../signals/theme.ts";
import {
  getAllowedAuthRedirectOriginsForCurrentPage,
  resolveAppAuthUrl,
  resolveAppUrl,
} from "../../signals/auth.ts";
import { getAuthV1ProviderAppearance } from "./provider-appearance.ts";

interface ClerkProviderProps {
  readonly children: ReactNode;
  readonly clerk: BrowserClerk;
  readonly ui: typeof ui;
  readonly signals: AuthV1ClerkSignals;
}

function ClerkRuntimeBoundary({
  children,
  signals,
}: Pick<ClerkProviderProps, "children" | "signals">) {
  const ready = useGet(signals.ready$);
  const attach = useSet(signals.attach$);

  return (
    <>
      <span hidden ref={attach} />
      {ready ? children : null}
    </>
  );
}

export function AuthV1ClerkProvider({
  children,
  clerk,
  ui,
  signals,
}: ClerkProviderProps) {
  const clerkLocalizations = useGet(clerkLocalizations$);
  const locale = useGet(locale$);
  const theme = useGet(theme$);
  const clerkRouterPush = useSet(signals.clerkRouterPush$);
  const clerkRouterReplace = useSet(signals.clerkRouterReplace$);

  const publishableKey = resolvePlatformRuntimeConfig().clerkPublishableKey;
  const appUrl = resolveAppUrl();
  const allowedRedirectOrigins = getAllowedAuthRedirectOriginsForCurrentPage();

  const providerProps = {
    Clerk: clerk,
    ui,
    afterSignOutUrl: resolveAppAuthUrl("/sign-in"),
    allowedRedirectOrigins,
    appearance: getAuthV1ProviderAppearance(theme),
    localization: clerkLocalizationForLocale(clerkLocalizations, locale),
    publishableKey,
    routerPush: clerkRouterPush,
    routerReplace: clerkRouterReplace,
    signInFallbackRedirectUrl: appUrl,
    signInUrl: resolveAppAuthUrl("/sign-in"),
    signUpFallbackRedirectUrl: appUrl,
    signUpUrl: resolveAppAuthUrl("/sign-up"),
  };
  return (
    <BaseClerkProvider {...providerProps}>
      <ClerkRuntimeBoundary signals={signals}>{children}</ClerkRuntimeBoundary>
    </BaseClerkProvider>
  );
}
