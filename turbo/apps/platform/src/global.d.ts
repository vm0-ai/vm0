interface VM0Global {
  loggers: DebugLoggers;
}

declare global {
  interface Window {
    _vm0: VM0Global | undefined;
  }
}

export {};
