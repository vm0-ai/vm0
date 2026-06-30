// Mock for @clerk/clerk-react
import { createElement, type ReactNode } from "react";

interface ClerkProviderProps {
  children: ReactNode;
  allowedRedirectOrigins?: readonly string[];
  localization?: unknown;
  signInFallbackRedirectUrl?: string;
  signInUrl?: string;
  signUpFallbackRedirectUrl?: string;
  signUpUrl?: string;
}

export function ClerkProvider({ children }: ClerkProviderProps) {
  return children;
}

interface ClerkAuthComponentProps {
  fallbackRedirectUrl?: string;
  forceRedirectUrl?: string;
  path?: string;
  routing?: string;
}

export function SignIn({ path, routing }: ClerkAuthComponentProps) {
  return createElement(
    "div",
    {
      "data-clerk-routing": routing,
      "data-testid": "clerk-sign-in",
    },
    path,
  );
}

export function SignUp({
  fallbackRedirectUrl,
  forceRedirectUrl,
  path,
  routing,
}: ClerkAuthComponentProps) {
  return createElement(
    "div",
    {
      "data-clerk-fallback-redirect-url": fallbackRedirectUrl,
      "data-clerk-force-redirect-url": forceRedirectUrl,
      "data-clerk-routing": routing,
      "data-testid": "clerk-sign-up",
    },
    path,
  );
}

interface GoogleOneTapProps {
  signInForceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export function GoogleOneTap({
  signInForceRedirectUrl,
  signUpForceRedirectUrl,
}: GoogleOneTapProps) {
  return createElement("div", {
    "data-testid": "clerk-google-one-tap",
    "data-sign-in-force-redirect-url": signInForceRedirectUrl,
    "data-sign-up-force-redirect-url": signUpForceRedirectUrl,
  });
}

export function OrganizationSwitcher(): string {
  return "OrganizationSwitcher";
}

interface OrgListProps {
  hidePersonal?: boolean;
  skipInvitationScreen?: boolean;
}

export function OrganizationList({
  hidePersonal,
  skipInvitationScreen,
}: OrgListProps) {
  return createElement("div", {
    "data-testid": "organization-list",
    "data-hide-personal": String(!!hidePersonal),
    "data-skip-invitation-screen": String(!!skipInvitationScreen),
  });
}
