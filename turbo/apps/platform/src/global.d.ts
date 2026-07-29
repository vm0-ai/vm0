import type { DebugLoggers } from "./types/global-method";

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
  interface Window {
    _vm0: VM0Global | undefined;
    __vm0BrowserSupported?: boolean;
    __vm0BrowserUpgrade?: VM0BrowserUpgradeCopy & { actionUrl: string };
    __vm0PreBundleCopy?: VM0PreBundleCopy;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
  }
}

export {};
