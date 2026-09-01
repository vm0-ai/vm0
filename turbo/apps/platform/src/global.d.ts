import type { PlatformClerk } from "./lib/clerk-runtime";
import type { DebugLoggers } from "./types/global-method";

interface VM0ClerkBootstrapLoadOptions {
  readonly afterSignOutUrl: string;
  readonly isSatellite?: true;
  readonly satelliteAutoSync?: true;
  readonly signInUrl: string;
  readonly signUpUrl: string;
}

interface VM0ClerkBootstrap {
  clerk?: PlatformClerk;
  readonly domain?: string;
  readonly loadOptions: VM0ClerkBootstrapLoadOptions;
  loaded?: Promise<void>;
  readonly productionPrimaryAppDomain: "app.okou.ai" | "app.vm0.ai";
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
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
    /** Set when the entry module graph has finished evaluating. */
    __appBootstrapModuleReady?: number;
    /**
     * Resolves after the main stylesheet is active and has crossed a rendering
     * opportunity, or after its preload fails so bootstrap can fail open.
     */
    __mainStylesheetLoaded?: Promise<void>;
  }
}

export {};
