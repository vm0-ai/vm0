import type { ClerkUIConstructor } from "@clerk/shared/ui";
import type { ui } from "@clerk/ui";
import type { PlatformClerk } from "./lib/clerk-runtime";
import type { DebugLoggers } from "./types/global-method";

interface OkouClerkBootstrapLoadOptions {
  readonly afterSignOutUrl: string;
  readonly signInUrl: string;
  readonly signUpUrl: string;
}

interface OkouClerkBootstrap {
  clerk?: PlatformClerk;
  readonly domain?: string;
  readonly loadOptions: OkouClerkBootstrapLoadOptions;
  loaded?: Promise<void>;
  uiLoaded?: Promise<typeof ui>;
  readonly publishableKey: string;
  /**
   * Resolves the hosted UI constructor promise the page passed to its early
   * `clerk.load`. The app calls it once the UI script is available.
   */
  readonly resolveClerkUI: (ui: ClerkUIConstructor) => void;
}

interface OkouGlobal {
  readonly rootSignal: AbortSignal;
  readonly switchClerkSession: (sessionId: string) => Promise<void>;
  loggers?: DebugLoggers;
  inspectLogs?: () => void;
  getBuildCommitSha?: () => string | null;
  getBuildVersion?: () => string | null;
}

declare global {
  const __OKOU_APP_VERSION__: string;

  interface Window {
    _okou: OkouGlobal | undefined;
    __okouClerkBootstrap?: OkouClerkBootstrap;
    __okouClerkUI?: typeof ui;
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
