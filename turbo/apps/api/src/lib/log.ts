import {
  EVENT,
  Logger as AxiomLogger,
  AxiomJSTransport,
} from "@axiomhq/logging";
import { Axiom } from "@axiomhq/js";

import { formatMessage, extractFields } from "@vm0/core";

import { env } from "./env";
import { singleton } from "./singleton";

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

const loggerRegistry = singleton(() => {
  return new LoggerRegistry();
});

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

// ── Axiom integration ────────────────────────────────────────────────────

const getAxiomLogger = singleton((): AxiomLogger | null => {
  const token = env("AXIOM_TOKEN_TELEMETRY");
  if (!token) {
    return null;
  }

  const axiom = new Axiom({ token });
  return new AxiomLogger({
    transports: [
      new AxiomJSTransport({
        axiom,
        dataset: `vm0-web-logs-${env("AXIOM_DATASET_SUFFIX")}`,
      }),
    ],
  });
});

function logToAxiom(level: Level, name: string, args: unknown[]): void {
  const alog = getAxiomLogger();
  if (!alog) {
    return;
  }

  const message = formatMessage(args);
  const data = {
    [EVENT]: { source: "api" },
    ...extractFields(args),
    context: name,
  };

  switch (level) {
    case Level.Debug: {
      alog.debug(message, data);
      break;
    }
    case Level.Info: {
      alog.info(message, data);
      break;
    }
    case Level.Warn: {
      alog.warn(message, data);
      break;
    }
    case Level.Error:
    case Level.Fatal: {
      alog.error(message, data);
      break;
    }
  }
}

export async function flushLogs(): Promise<void> {
  await getAxiomLogger()
    ?.flush()
    ?.catch(() => {});
}

// ── Logger creation ──────────────────────────────────────────────────────

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
      logToAxiom(Level.Debug, name, args);
    },
    info: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Info)) {
        writeLog(...formatArgs(Level.Info, name, args));
      }
      logToAxiom(Level.Info, name, args);
    },
    warn: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Warn)) {
        writeLog(...formatArgs(Level.Warn, name, args));
      }
      logToAxiom(Level.Warn, name, args);
    },
    error: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Error)) {
        writeError(...formatArgs(Level.Error, name, args));
      }
      logToAxiom(Level.Error, name, args);
    },
    fatal: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Fatal)) {
        writeError(...formatArgs(Level.Fatal, name, args));
      }
      logToAxiom(Level.Fatal, name, args);
    },
  };

  return loggerInstance;
}

export function logger(name: string): Logger {
  const registry = loggerRegistry();
  const existing = registry.get(name);
  if (existing) {
    return existing;
  }

  const loggerInstance = createLogger(name);
  registry.set(name, loggerInstance);
  return loggerInstance;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetForTest(): void {
  getAxiomLogger.reset();
  loggerRegistry.reset();
}
