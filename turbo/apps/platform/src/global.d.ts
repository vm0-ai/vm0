import type { PlatformClerk } from "./lib/clerk-runtime";
import type { DebugLoggers } from "./types/global-method";

interface OkouClerkBootstrapLoadOptions {
  readonly afterSignOutUrl: string;
  readonly isSatellite?: true;
  readonly satelliteAutoSync?: true;
  readonly signInUrl: string;
  readonly signUpUrl: string;
}

interface OkouClerkBootstrap {
  clerk?: PlatformClerk;
  readonly domain?: string;
  readonly loadOptions: OkouClerkBootstrapLoadOptions;
  loaded?: Promise<void>;
  readonly productionPrimaryAppDomain: "app.okou.ai" | "app.vm0.ai";
  readonly publishableKey: string;
}

interface OkouGlobal {
  loggers: DebugLoggers;
  inspectLogs: () => void;
  getBuildCommitSha: () => string | null;
  getBuildVersion: () => string | null;
}

declare global {
  const __OKOU_APP_VERSION__: string;

  interface Window {
    _okou: OkouGlobal | undefined;
    __okouClerkBootstrap?: OkouClerkBootstrap;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
    /** Set when the entry module graph has finished evaluating. */
    __appBootstrapModuleReady?: number;
    /**
     * Reports whether the main stylesheet became active after crossing a
     * rendering opportunity or failed to load.
     */
    __mainStylesheetLoaded?: Promise<"failed" | "loaded">;
  }
}

export {};
