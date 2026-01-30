/**
 * Global Logger Module
 *
 * Provides unified logging across all runner modules.
 * Default: console.log / console.error
 * Benchmark mode: Timer.log (both log and error go to Timer.log)
 */

type LogFn = (message: string) => void;

let _log: LogFn | null = null;
let _error: LogFn | null = null;

// Getters that lazily resolve to console.log/error if not set
// This allows tests to mock console before the logger is used
function getLog(): LogFn {
  return _log ?? console.log.bind(console);
}

function getError(): LogFn {
  return _error ?? console.error.bind(console);
}

/**
 * Set the global logger functions
 * Call this at application entry point (benchmark.ts)
 * @param log - Function for normal log output
 * @param error - Function for error output (defaults to log if not provided)
 */
export function setGlobalLogger(log: LogFn, error?: LogFn): void {
  _log = log;
  _error = error ?? log;
}

/**
 * Logger interface with log and error methods
 */
interface Logger {
  log: LogFn;
  error: LogFn;
}

/**
 * Create a logger with a module prefix
 * @param prefix Module name (e.g., 'VMSetup', 'Executor')
 */
export function createLogger(prefix: string): Logger {
  return {
    log: (message: string) => getLog()(`[${prefix}] ${message}`),
    error: (message: string) => getError()(`[${prefix}] ${message}`),
  };
}
