const SERIALIZED_VALUE_MAX_DEPTH = 32;
const SERIALIZED_OBJECT_MAX_ENTRIES = 64;
const CIRCULAR_MARKER = "[Circular]";
const TRUNCATED_MARKER = "[Truncated]";

/**
 * Extract message string from log arguments.
 */
export function formatMessage(args: unknown[]): string {
  if (args.length === 0) return "";
  if (typeof args[0] === "string") return args[0];
  if (args[0] instanceof Error) return args[0].message;
  return String(args[0]);
}

/**
 * Serialize an Error instance into a plain object. Error's built-in
 * properties (name, message, stack, cause) are non-enumerable, so spreading
 * an Error loses them. This explicitly copies them plus any additional
 * enumerable own properties (e.g. code, statusCode on custom errors).
 */
function serializeErrorWithSeen(
  err: Error,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  seen.add(err);
  if (err.cause !== undefined) {
    serialized.cause = serializeErrorValue(err.cause, seen, depth + 1);
  }
  for (const [key, value] of Object.entries(
    err as unknown as Record<string, unknown>,
  )) {
    if (!(key in serialized)) {
      serialized[key] = serializeErrorValue(value, seen, depth + 1);
    }
  }
  return serialized;
}

export function serializeError(err: Error): Record<string, unknown> {
  return serializeErrorWithSeen(err, new WeakSet<object>(), 0);
}

function serializeErrorValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return value.name ? `[Function ${value.name}]` : "[Function]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR_MARKER;
  }
  if (depth > SERIALIZED_VALUE_MAX_DEPTH) {
    return TRUNCATED_MARKER;
  }
  if (value instanceof Error) {
    return serializeErrorWithSeen(value, seen, depth);
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? value.toString() : value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, SERIALIZED_OBJECT_MAX_ENTRIES).map((item) => {
      return serializeErrorValue(item, seen, depth + 1);
    });
    if (value.length > SERIALIZED_OBJECT_MAX_ENTRIES) {
      items.push(TRUNCATED_MARKER);
    }
    return items;
  }

  const serialized: Record<string, unknown> = {};
  let entryCount = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (entryCount >= SERIALIZED_OBJECT_MAX_ENTRIES) {
      serialized.__truncated = true;
      break;
    }
    serialized[key] = serializeErrorValue(child, seen, depth + 1);
    entryCount += 1;
  }
  return serialized;
}

/**
 * Extract structured fields from log arguments.
 * If second argument is an object, use it as fields.
 * If second argument is an Error, wrap it under `error` with non-enumerable
 * properties (name/message/stack/cause) explicitly serialized.
 * Otherwise, wrap remaining arguments in an 'args' field.
 */
export function extractFields(args: unknown[]): Record<string, unknown> {
  if (args.length <= 1) {
    if (args.length === 1 && args[0] instanceof Error) {
      return { error: serializeError(args[0]) };
    }
    return {};
  }
  const fields = args.slice(1);
  if (
    fields.length === 1 &&
    typeof fields[0] === "object" &&
    fields[0] !== null
  ) {
    const value = fields[0];
    if (value instanceof Error) {
      return { error: serializeError(value) };
    }
    return value as Record<string, unknown>;
  }
  return { args: fields };
}
