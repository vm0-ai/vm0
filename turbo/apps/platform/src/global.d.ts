import type { DebugLoggers, DebugFeatureSwitches } from "./types/global-method";

interface VM0Global {
  loggers: DebugLoggers;
  featureSwitches: DebugFeatureSwitches;
  inspectLogs: () => void;
}

declare global {
  interface Window {
    _vm0: VM0Global | undefined;
  }
}

export {};
