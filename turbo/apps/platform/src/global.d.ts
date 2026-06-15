import type { DebugLoggers } from "./types/global-method";

interface VM0Global {
  loggers: DebugLoggers;
  inspectLogs: () => void;
}

declare global {
  interface Window {
    _vm0: VM0Global | undefined;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
  }
}

export {};
