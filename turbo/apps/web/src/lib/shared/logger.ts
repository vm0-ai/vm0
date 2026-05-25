/**
 * Lightweight structured logging system with VM0_DEBUG environment variable support.
 *
 * Usage:
 *   const log = logger('service:runner')
 *   log.debug('job queued', { id: '123' })        // Only when VM0_DEBUG matches
 *   log.warn('slow response')                     // Always output
 *   log.error('failed', error)                    // Always output
 *
 * Environment:
 *   VM0_DEBUG=service:runner  - Enable specific logger
 *   VM0_DEBUG=service:*       - Enable all service loggers (wildcard)
 *   VM0_DEBUG=*               - Enable all debug output
 *   VM0_DEBUG=a,b,c           - Enable multiple loggers
 *
 * Auto-enabled:
 *   - Local development (NODE_ENV=development) automatically enables VM0_DEBUG=*
 *
 * Production/Preview:
 *   - VM0_DEBUG must be explicitly set via environment variables
 *   - Preview deployments: VM0_DEBUG=* is set via GitHub Actions workflow
 *
 * Axiom Integration:
 *   - When AXIOM_TOKEN_TELEMETRY is configured, logs are also sent to Axiom
 *   - Logs are sent as structured JSON with context and fields
 *   - Console output is preserved for Vercel logs (dual-write)
 */
import {
  EVENT,
  Logger as AxiomLogger,
  AxiomJSTransport,
} from "@axiomhq/logging";
import { formatMessage, extractFields } from "@vm0/core";
import { getDatasetName, DATASETS } from "./axiom/datasets";
import { getTelemetryInstance } from "./axiom/instances";

type LogMethod = (...args: unknown[]) => void;

interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

const loggerCache: Map<string, Logger> = new Map();

// Axiom logger singleton (separate from axiom/client.ts to avoid circular dependency)
let axiomLogger: AxiomLogger | null = null;
let axiomInitialized = false;

/**
 * Get or create the Axiom logger for web logs.
 * Uses the shared telemetry Axiom instance from axiom/instances.ts so that
 * a single flushAxiom() call covers web-logs alongside all other datasets.
 * Returns null if no token is configured.
 */
function getAxiomLogger(): AxiomLogger | null {
  if (axiomInitialized) return axiomLogger;
  axiomInitialized = true;

  const token = process.env.AXIOM_TOKEN_TELEMETRY;
  const axiom = getTelemetryInstance(token);
  if (!axiom) {
    return null;
  }

  axiomLogger = new AxiomLogger({
    transports: [
      new AxiomJSTransport({
        axiom,
        dataset: getDatasetName(DATASETS.WEB_LOGS),
      }),
    ],
  });

  return axiomLogger;
}

function isAutoDebugEnabled(): boolean {
  // Read process.env directly — logger() is called at module scope by many
  // files, so this must not trigger full env() validation at import time.
  return process.env.NODE_ENV === "development";
}

function getDebugPatterns(): string[] {
  const debug = process.env.VM0_DEBUG;

  // If VM0_DEBUG is explicitly set, use it
  if (debug) {
    return debug.split(",").map((p) => {
      return p.trim();
    });
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
      // Also send to Axiom (if configured)
      getAxiomLogger()?.debug(formatMessage(args), {
        [EVENT]: { source: "web" },
        ...extractFields(args),
        context: name,
      });
    },
    info: (...args: unknown[]) => {
      console.info(...formatArgs("INFO", name, args));
      getAxiomLogger()?.info(formatMessage(args), {
        [EVENT]: { source: "web" },
        ...extractFields(args),
        context: name,
      });
    },
    warn: (...args: unknown[]) => {
      console.warn(...formatArgs("WARN", name, args));
      getAxiomLogger()?.warn(formatMessage(args), {
        [EVENT]: { source: "web" },
        ...extractFields(args),
        context: name,
      });
    },
    error: (...args: unknown[]) => {
      console.error(...formatArgs("ERROR", name, args));
      getAxiomLogger()?.error(formatMessage(args), {
        [EVENT]: { source: "web" },
        ...extractFields(args),
        context: name,
      });
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
