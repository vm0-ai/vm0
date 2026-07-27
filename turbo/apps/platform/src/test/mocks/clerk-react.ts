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
  fallback?: ReactNode;
  fallbackRedirectUrl?: string;
  forceRedirectUrl?: string;
  path?: string;
  routing?: string;
}

function ClerkAuthComponent({
  componentName,
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
