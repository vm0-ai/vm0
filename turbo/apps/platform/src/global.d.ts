import type { DebugLoggers } from "./types/global-method";

interface VM0Global {
  loggers: DebugLoggers;
  inspectLogs: () => void;
  getBuildCommitSha: () => string | null;
  getBuildVersion: () => string | null;
}

declare global {
  interface Window {
    _vm0: VM0Global | undefined;
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
