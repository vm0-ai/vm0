// Mock for @clerk/react
import {
  createElement,
  Fragment,
  type ReactNode,
  useSyncExternalStore,
} from "react";
import { vi } from "vitest";

const CLERK_AUTH_COMPONENT_MOUNT_EVENT = "vm0:test-clerk-auth-component-mount";
const getClerkAuthComponentMounted = vi.fn<() => boolean>(() => {
  return true;
});

export function setMockClerkAuthComponentMounted(mounted: boolean): void {
  if (getClerkAuthComponentMounted() === mounted) {
    return;
  }
  getClerkAuthComponentMounted.mockReturnValue(mounted);
  window.dispatchEvent(new Event(CLERK_AUTH_COMPONENT_MOUNT_EVENT));
}

export function resetMockClerkAuthComponentMounted(): void {
  getClerkAuthComponentMounted.mockReturnValue(true);
}

function subscribeToClerkAuthComponent(listener: () => void): () => void {
  const handleMountChange = () => {
    listener();
  };
  window.addEventListener(CLERK_AUTH_COMPONENT_MOUNT_EVENT, handleMountChange);
  return () => {
    window.removeEventListener(
      CLERK_AUTH_COMPONENT_MOUNT_EVENT,
      handleMountChange,
    );
  };
}

interface ClerkProviderProps {
  children: ReactNode;
  allowedRedirectOrigins?: readonly (string | RegExp)[];
  localization?: {
    signIn?: {
      emailCode?: { subtitle?: string };
      start?: { actionLink?: string; title?: string };
    };
    unstable__errors?: {
      not_allowed_access?: string;
      user_banned?: string;
    };
  };
  signInFallbackRedirectUrl?: string;
  signInUrl?: string;
  signUpFallbackRedirectUrl?: string;
  signUpUrl?: string;
  touchSession?: boolean;
}

export function ClerkProvider({
  children,
  localization,
  touchSession,
}: ClerkProviderProps) {
  return createElement(
    Fragment,
    null,
    createElement("span", {
      "data-clerk-sign-in-email-code-subtitle":
        localization?.signIn?.emailCode?.subtitle,
      "data-clerk-sign-in-start-action-link":
        localization?.signIn?.start?.actionLink,
      "data-clerk-sign-in-start-title": localization?.signIn?.start?.title,
      "data-clerk-access-not-allowed-error":
        localization?.unstable__errors?.not_allowed_access,
      "data-clerk-user-banned-error":
        localization?.unstable__errors?.user_banned,
      "data-clerk-touch-session":
        touchSession === undefined ? undefined : String(touchSession),
      "data-testid": "clerk-provider-config",
      hidden: true,
    }),
    children,
  );
}

interface ClerkAuthComponentProps {
  appearance?: {
    options?: {
      logoImageUrl?: string;
      logoPlacement?: string;
    };
  };
  fallback?: ReactNode;
  fallbackRedirectUrl?: string;
  forceRedirectUrl?: string;
  path?: string;
  routing?: string;
}

function ClerkAuthComponent({
  componentName,
  appearance,
  fallback,
  fallbackRedirectUrl,
  forceRedirectUrl,
  path,
  routing,
  testId,
}: ClerkAuthComponentProps & {
  componentName: string;
  testId: string;
}) {
  const mounted = useSyncExternalStore(
    subscribeToClerkAuthComponent,
    getClerkAuthComponentMounted,
  );

  return createElement(
    Fragment,
    null,
    mounted ? null : fallback,
    createElement(
      "div",
      {
        "data-clerk-component": componentName,
        "data-clerk-fallback-redirect-url": fallbackRedirectUrl,
        "data-clerk-force-redirect-url": forceRedirectUrl,
        "data-clerk-logo-image-url": appearance?.options?.logoImageUrl,
        "data-clerk-logo-placement": appearance?.options?.logoPlacement,
        "data-clerk-routing": routing,
        "data-testid": testId,
      },
      mounted ? createElement("span", null, path) : null,
    ),
  );
}

export function SignIn(props: ClerkAuthComponentProps) {
  return createElement(ClerkAuthComponent, {
    ...props,
    componentName: "SignIn",
    testId: "clerk-sign-in",
  });
}

export function SignUp(props: ClerkAuthComponentProps) {
  return createElement(ClerkAuthComponent, {
    ...props,
    componentName: "SignUp",
    testId: "clerk-sign-up",
  });
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
