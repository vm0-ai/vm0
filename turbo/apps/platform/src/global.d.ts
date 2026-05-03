import type { DebugLoggers } from "./types/global-method";

interface VM0Global {
  loggers: DebugLoggers;
  inspectLogs: () => void;
}

declare global {
  interface Window {
    _vm0: VM0Global | undefined;
  }
}

export {};
