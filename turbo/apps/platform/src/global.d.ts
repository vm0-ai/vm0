import type { ClerkUIConstructor } from "@clerk/shared/ui";
import type { PlatformClerk } from "./lib/clerk-runtime";
import type { DebugLoggers } from "./types/global-method";

interface VM0ClerkBootstrapIdentity {
  readonly orgId: string;
  readonly sessionId: string;
  readonly userId: string;
}

interface VM0ClerkBootstrapOnboardingStatus {
  readonly body: unknown;
  readonly identity: VM0ClerkBootstrapIdentity;
  readonly status: number;
}

interface VM0ClerkBootstrapLoadOptions {
  readonly afterSignOutUrl: string;
  readonly isSatellite?: true;
  readonly satelliteAutoSync?: true;
  readonly signInUrl: string;
  readonly signUpUrl: string;
}

interface VM0ClerkBootstrap {
  readonly abortOnboarding: () => void;
  readonly clientSessionId?: string;
  clerk?: PlatformClerk;
  clerkLoadCompletedAt?: number;
  clerkLoadStartedAt?: number;
  readonly clerkUiPromise: Promise<ClerkUIConstructor>;
  readonly domain?: string;
  readonly loadOptions: VM0ClerkBootstrapLoadOptions;
  loaded?: Promise<void>;
  onboardingStatusPromise?: Promise<VM0ClerkBootstrapOnboardingStatus | null>;
  readonly publishableKey: string;
  readonly rejectClerkUi: (reason?: unknown) => void;
  readonly resolveClerkUi: (constructor: ClerkUIConstructor) => void;
}

interface VM0Global {
  loggers: DebugLoggers;
  inspectLogs: () => void;
  getBuildCommitSha: () => string | null;
  getBuildVersion: () => string | null;
}

interface VM0BrowserUpgradeCopy {
  actionLabel: string;
  description: string;
  title: string;
}

interface VM0PreBundleCopy {
  browserUpgrade: {
    browser: VM0BrowserUpgradeCopy;
    chrome: VM0BrowserUpgradeCopy;
    chromium: VM0BrowserUpgradeCopy;
    ios: VM0BrowserUpgradeCopy;
    safari: VM0BrowserUpgradeCopy;
  };
  loading: {
    ariaLabel: string;
    messages: string[];
  };
  metadata: {
    description: string;
    title: string;
  };
}

declare global {
  const __OKOU_APP_GIT_COMMIT_SHA__: string;
  const __OKOU_APP_VERSION__: string;

  interface Window {
    _vm0: VM0Global | undefined;
    __vm0BrowserSupported?: boolean;
    __vm0ClerkBootstrap?: VM0ClerkBootstrap;
    __vm0BrowserUpgrade?: VM0BrowserUpgradeCopy & { actionUrl: string };
    __vm0PreBundleCopy?: VM0PreBundleCopy;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
    /** Set when the entry module graph has finished evaluating. */
    __appBootstrapModuleReady?: number;
  }
}

export {};
