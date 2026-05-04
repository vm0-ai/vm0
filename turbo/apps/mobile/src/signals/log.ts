/**
 * Logger utilities for the mobile app.
 */
type LogFn = (...args: unknown[]) => void;

const noop: LogFn = () => {};

const info: LogFn = (...args: unknown[]) => {
  console.info(...args);
};
const warn: LogFn = (...args: unknown[]) => {
  console.warn(...args);
};
const error: LogFn = (...args: unknown[]) => {
  console.error(...args);
};

function createLogger(_name: string) {
  return {
    debug: noop,
    info,
    warn,
    error,
    debugGroup(label: string): void {
      console.group(label);
    },
    debugGroupEnd(): void {
      console.groupEnd();
    },
  };
}

export const logger = (name: string) => {
  return createLogger(name);
};
