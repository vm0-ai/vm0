/**
 * Lightweight structured logging system with VM0_DEBUG environment variable support.
 *
 * Usage:
 *   const log = logger('service:e2b')
 *   log.debug('sandbox created', { id: '123' })  // Only when VM0_DEBUG matches
 *   log.warn('slow response')                     // Always output
 *   log.error('failed', error)                    // Always output
 *
 * Environment:
 *   VM0_DEBUG=service:e2b     - Enable specific logger
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
import "server-only";
import { Logger as AxiomLogger, AxiomJSTransport } from "@axiomhq/logging";
import { Axiom } from "@axiomhq/js";
import { getDatasetName, DATASETS } from "./axiom/datasets";

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
 * Uses a separate Axiom client instance to avoid circular dependency with axiom/client.ts.
 * Uses AXIOM_TOKEN_TELEMETRY for the telemetry scope.
 * Returns null if no token is configured.
 */
function getAxiomLogger(): AxiomLogger | null {
  if (axiomInitialized) return axiomLogger;
  axiomInitialized = true;

  const token = process.env.AXIOM_TOKEN_TELEMETRY;
  if (!token) {
    return null;
  }

  const axiom = new Axiom({ token });
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

/**
 * Extract message string from log arguments.
 */
function formatMessage(args: unknown[]): string {
  if (args.length === 0) return "";
  if (typeof args[0] === "string") return args[0];
  return String(args[0]);
}

/**
 * Extract structured fields from log arguments.
 * If second argument is an object, use it as fields.
 * Otherwise, wrap remaining arguments in an 'args' field.
 */
function extractFields(args: unknown[]): Record<string, unknown> {
  if (args.length <= 1) return {};
  const fields = args.slice(1);
  if (
    fields.length === 1 &&
    typeof fields[0] === "object" &&
    fields[0] !== null
  ) {
    return fields[0] as Record<string, unknown>;
  }
  return { args: fields };
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
      // Also send to Axiom (if configured)
      getAxiomLogger()?.debug(formatMessage(args), {
        context: name,
        ...extractFields(args),
      });
    },
    info: (...args: unknown[]) => {
      console.info(...formatArgs("INFO", name, args));
      getAxiomLogger()?.info(formatMessage(args), {
        context: name,
        ...extractFields(args),
      });
    },
    warn: (...args: unknown[]) => {
      console.warn(...formatArgs("WARN", name, args));
      getAxiomLogger()?.warn(formatMessage(args), {
        context: name,
        ...extractFields(args),
      });
    },
    error: (...args: unknown[]) => {
      console.error(...formatArgs("ERROR", name, args));
      getAxiomLogger()?.error(formatMessage(args), {
        context: name,
        ...extractFields(args),
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

/**
 * Flush all pending logs to Axiom.
 * MUST be called before serverless function terminates to ensure log delivery.
 *
 * Usage in API routes:
 *   await flushLogs();
 *   return Response.json(data);
 */
export async function flushLogs(): Promise<void> {
  try {
    await axiomLogger?.flush();
  } catch (e) {
    // Log to console as fallback if Axiom flush fails
    // Don't throw - we don't want flush failures to break the response
    console.error("[logger] Failed to flush logs to Axiom:", e);
  }
}
