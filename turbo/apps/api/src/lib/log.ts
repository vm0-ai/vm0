import { env } from "./env";

type LogMethod = (...args: unknown[]) => void;

enum Level {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
  Fatal = "fatal",
}

const LOG_LEVEL_PRIORITY: Readonly<Record<Level, number>> = {
  [Level.Debug]: 0,
  [Level.Info]: 1,
  [Level.Warn]: 2,
  [Level.Error]: 3,
  [Level.Fatal]: 4,
};

interface Logger {
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  readonly fatal: LogMethod;
  readonly shouldLog: (level: Level) => boolean;
  level: Level;
}

class LoggerRegistry {
  private readonly store = new Map<string, Logger>();

  get(name: string): Logger | undefined {
    return this.store.get(name);
  }

  set(name: string, loggerInstance: Logger): void {
    this.store.set(name, loggerInstance);
  }
}

const loggerRegistry = new LoggerRegistry();

function getDebugPatterns(): string[] {
  const value = env("VM0_DEBUG");
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((pattern) => {
      return pattern.trim();
    })
    .filter((pattern) => {
      return pattern.length > 0;
    });
}

function matchesDebugPattern(name: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith(":*")) {
    return name.startsWith(pattern.slice(0, -1));
  }

  return name === pattern;
}

function isDebugEnabled(name: string): boolean {
  return getDebugPatterns().some((pattern) => {
    return matchesDebugPattern(name, pattern);
  });
}

function getInitialLevel(name: string): Level {
  return isDebugEnabled(name) ? Level.Debug : Level.Info;
}

function formatArgs(
  level: Level,
  name: string,
  args: unknown[],
): [string, ...unknown[]] {
  const prefix = `[${level.toUpperCase()}][${name}]`;
  if (args.length === 0) {
    return [prefix];
  }

  if (typeof args[0] === "string") {
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }

  return [prefix, ...args];
}

function writeLog(...args: unknown[]): void {
  console.log(...args);
}

function writeError(...args: unknown[]): void {
  console.error(...args);
}

function createLogger(name: string): Logger {
  const loggerInstance: Logger = {
    level: getInitialLevel(name),
    shouldLog(level: Level): boolean {
      return (
        LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[loggerInstance.level]
      );
    },
    debug: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Debug)) {
        writeLog(...formatArgs(Level.Debug, name, args));
      }
    },
    info: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Info)) {
        writeLog(...formatArgs(Level.Info, name, args));
      }
    },
    warn: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Warn)) {
        writeLog(...formatArgs(Level.Warn, name, args));
      }
    },
    error: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Error)) {
        writeError(...formatArgs(Level.Error, name, args));
      }
    },
    fatal: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Fatal)) {
        writeError(...formatArgs(Level.Fatal, name, args));
      }
    },
  };

  return loggerInstance;
}

export function logger(name: string): Logger {
  const existing = loggerRegistry.get(name);
  if (existing) {
    return existing;
  }

  const loggerInstance = createLogger(name);
  loggerRegistry.set(name, loggerInstance);
  return loggerInstance;
}
