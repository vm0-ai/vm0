/**
 * Lightweight structured logging system with DEBUG environment variable support.
 *
 * Usage:
 *   const log = logger('service:e2b')
 *   log.debug('sandbox created', { id: '123' })  // Only when DEBUG matches
 *   log.warn('slow response')                     // Always output
 *   log.error('failed', error)                    // Always output
 *
 * Environment:
 *   DEBUG=service:e2b     - Enable specific logger
 *   DEBUG=service:*       - Enable all service loggers (wildcard)
 *   DEBUG=*               - Enable all debug output
 *   DEBUG=a,b,c           - Enable multiple loggers
 *
 * Auto-enabled:
 *   - Local development (NODE_ENV=development) automatically enables DEBUG=*
 *
 * Production/Preview:
 *   - DEBUG must be explicitly set via environment variables
 *   - Preview deployments: DEBUG=* is set via GitHub Actions workflow
 */

type LogMethod = (...args: unknown[]) => void;

interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

const loggerCache: Map<string, Logger> = new Map();

function isAutoDebugEnabled(): boolean {
  // Auto-enable debug in local development
  return process.env.NODE_ENV === "development";
}

function getDebugPatterns(): string[] {
  const debug = process.env.DEBUG;

  // If DEBUG is explicitly set, use it
  if (debug) {
    return debug.split(",").map((p) => p.trim());
  }

  // Auto-enable all debug in development/preview
  if (isAutoDebugEnabled()) {
    return ["*"];
  }

  return [];
}

function matchesDebug(name: string): boolean {
  const patterns = getDebugPatterns();
  if (patterns.length === 0) return false;

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -1);
      return name.startsWith(prefix);
    }
    return name === pattern;
  });
}

function formatArgs(
  level: string,
  name: string,
  args: unknown[],
): [string, ...unknown[]] {
  const prefix = `[${level}] [${name}]`;
  if (args.length === 0) {
    return [prefix];
  }
  if (typeof args[0] === "string") {
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }
  return [prefix, ...args];
}

function createLogger(name: string): Logger {
  const isDebugEnabled = matchesDebug(name);

  return {
    debug: (...args: unknown[]) => {
      if (!isDebugEnabled) return;
      console.log(...formatArgs("DEBUG", name, args));
    },
    info: (...args: unknown[]) => {
      console.info(...formatArgs("INFO", name, args));
    },
    warn: (...args: unknown[]) => {
      console.warn(...formatArgs("WARN", name, args));
    },
    error: (...args: unknown[]) => {
      console.error(...formatArgs("ERROR", name, args));
    },
  };
}

export function logger(name: string): Logger {
  const cached = loggerCache.get(name);
  if (cached) return cached;

  const newLogger = createLogger(name);
  loggerCache.set(name, newLogger);
  return newLogger;
}

export function clearLoggerCache(): void {
  loggerCache.clear();
}
