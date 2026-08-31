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
  readonly domain?: string;
  readonly loadOptions: VM0ClerkBootstrapLoadOptions;
  loaded?: Promise<void>;
  onboardingStatusPromise?: Promise<VM0ClerkBootstrapOnboardingStatus | null>;
  readonly publishableKey: string;
}

interface VM0Global {
  loggers: DebugLoggers;
  inspectLogs: () => void;
  getBuildCommitSha: () => string | null;
  getBuildVersion: () => string | null;
}

declare global {
  const __OKOU_APP_VERSION__: string;

  interface Window {
    _vm0: VM0Global | undefined;
    __vm0ClerkBootstrap?: VM0ClerkBootstrap;
    __vm0AfterFirstPaint?: (callback: () => void) => void;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
    /** Upper bound recorded immediately after the first visible paint. */
    __appBootstrapFirstPaintUpperBound?: number;
    /** Set when the entry module graph has finished evaluating. */
    __appBootstrapModuleReady?: number;
  }
}

export {};
