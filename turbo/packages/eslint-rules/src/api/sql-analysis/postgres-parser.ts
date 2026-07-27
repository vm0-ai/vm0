import { createRequire } from "node:module";

const POSTGRES_MAJOR_VERSION = 17;

type UnknownFunction = (...args: unknown[]) => unknown;
type ErrorConstructor = abstract new (...args: never[]) => Error;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === "function";
}

function isErrorConstructor(value: unknown): value is ErrorConstructor {
  if (typeof value !== "function") {
    return false;
  }
  const prototype: unknown = value.prototype;
  return prototype instanceof Error;
}

const require = createRequire(import.meta.url);
const parserModule: unknown = require("libpg-query");
if (
  !isRecord(parserModule) ||
  !isUnknownFunction(parserModule.loadModule) ||
  !isUnknownFunction(parserModule.parseSync) ||
  !isErrorConstructor(parserModule.SqlError)
) {
  throw new Error("libpg-query returned an unexpected module shape");
}
const loadModule = parserModule.loadModule;
const parseSync = parserModule.parseSync;
const SqlError = parserModule.SqlError;

await loadModule();

interface PostgresParseResult {
  readonly statements: readonly unknown[];
}

export function parsePostgres(source: string): PostgresParseResult | null {
  try {
    const parsed: unknown = parseSync(source);
    if (
      !isRecord(parsed) ||
      typeof parsed.version !== "number" ||
      Math.floor(parsed.version / 10_000) !== POSTGRES_MAJOR_VERSION ||
      !Array.isArray(parsed.stmts)
    ) {
      throw new Error("libpg-query returned an unexpected PostgreSQL AST");
    }
    return {
      statements: parsed.stmts,
    };
  } catch (error) {
    if (error instanceof SqlError) {
      return null;
    }
    throw error;
  }
}
