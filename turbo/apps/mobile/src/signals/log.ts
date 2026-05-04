/**
 * Logger utilities for the mobile app.
 */
type LogFn = (...args: unknown[]) => void;

// eslint-disable-next-line no-console
const noop: LogFn = () => {};

// eslint-disable-next-line no-console
const _debug: LogFn = (...args: unknown[]) => {
  console.debug(...args);
};
const _info: LogFn = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.info(...args);
};
const _warn: LogFn = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.warn(...args);
};
const _error: LogFn = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.error(...args);
};

function createLogger(name: string) {
  return {
    debug: noop,
    info: _info,
    warn: _warn,
    error: _error,
    debugGroup(label: string): void {
      // eslint-disable-next-line no-console
      console.group(label);
    },
    debugGroupEnd(): void {
      // eslint-disable-next-line no-console
      console.groupEnd();
    },
  };
}

export const logger = (name: string) => {
  return createLogger(name);
};

export const setLogErrorHandler = (_handler: (name: string, args: unknown[]) => void): void => {};
