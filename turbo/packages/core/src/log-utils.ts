const SERIALIZED_VALUE_MAX_DEPTH = 32;
const SERIALIZED_OBJECT_MAX_ENTRIES = 64;
const CIRCULAR_MARKER = "[Circular]";
const TRUNCATED_MARKER = "[Truncated]";
const UNREADABLE_MARKER = "[Unreadable]";

interface BoundedEntries {
  readonly entries: readonly [string, unknown][];
  readonly truncated: boolean;
}

/**
 * Extract message string from log arguments.
 */
export function formatMessage(args: unknown[]): string {
  if (args.length === 0) return "";
  if (typeof args[0] === "string") return args[0];
  if (args[0] instanceof Error) {
    const message = safeReadValue(() => {
      return args[0] instanceof Error ? args[0].message : undefined;
    });
    return typeof message === "string" ? message : UNREADABLE_MARKER;
  }
  return safeString(args[0]);
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
  const name = safeReadValue(() => {
    return err.name;
  });
  const message = safeReadValue(() => {
    return err.message;
  });
  const serialized: Record<string, unknown> = {
    name: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : UNREADABLE_MARKER,
    stack: safeReadValue(() => {
      return err.stack;
    }),
  };
  seen.add(err);
  const cause = safeReadValue(() => {
    return err.cause;
  });
  if (cause !== undefined) {
    serialized.cause = serializeErrorValue(cause, seen, depth + 1);
  }
  const result = safeOwnEnumerableEntries(err);
  if (!result) {
    serialized.__unreadable = true;
    return serialized;
  }
  for (const [key, value] of result.entries) {
    if (!(key in serialized)) {
      serialized[key] = serializeErrorValue(value, seen, depth + 1);
    }
  }
  if (result.truncated) {
    serialized.__truncated = true;
  }
  return serialized;
}

export function serializeError(err: Error): Record<string, unknown> {
  return serializeErrorWithSeen(err, new WeakSet<object>(), 0);
}

function safeReadValue(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNREADABLE_MARKER;
  }
}

function safeOwnEnumerableEntries(value: object): BoundedEntries | null {
  const entries: [string, unknown][] = [];
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        continue;
      }
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
        continue;
      }
      if (entries.length >= SERIALIZED_OBJECT_MAX_ENTRIES) {
        return { entries, truncated: true };
      }
      const child = safeReadValue(() => {
        return (value as Record<string, unknown>)[key];
      });
      entries.push([key, child]);
    }
  } catch {
    return null;
  }
  return { entries, truncated: false };
}

function safeString(value: unknown): string {
  const result = safeReadValue(() => {
    return String(value);
  });
  return typeof result === "string" ? result : UNREADABLE_MARKER;
}

function serializeFunctionValue(value: { readonly name: string }): string {
  const name = safeReadValue(() => {
    return value.name;
  });
  return typeof name === "string" && name ? `[Function ${name}]` : "[Function]";
}

function serializeNonObjectValue(value: unknown): unknown {
  if (typeof value === "bigint" || typeof value === "symbol") {
    return safeString(value);
  }
  if (typeof value === "function") {
    return serializeFunctionValue(value);
  }
  return value;
}

function isObjectValue(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function serializeDateValue(value: Date): unknown {
  const time = safeReadValue(() => {
    return value.getTime();
  });
  if (typeof time !== "number" || Number.isNaN(time)) {
    return safeString(value);
  }
  const iso = safeReadValue(() => {
    return value.toISOString();
  });
  return typeof iso === "string" ? iso : UNREADABLE_MARKER;
}

function serializeArrayValue(
  value: readonly unknown[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  const result = safeOwnEnumerableEntries(value);
  if (!result) {
    return UNREADABLE_MARKER;
  }
  const items = result.entries.map((item) => {
    const [, child] = item;
    return serializeErrorValue(child, seen, depth + 1);
  });
  if (result.truncated) {
    items.push(TRUNCATED_MARKER);
  }
  return items;
}

function serializePlainObjectValue(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  const result = safeOwnEnumerableEntries(value);
  if (!result) {
    return UNREADABLE_MARKER;
  }
  const serialized: Record<string, unknown> = {};
  for (const [key, child] of result.entries) {
    serialized[key] = serializeErrorValue(child, seen, depth + 1);
  }
  if (result.truncated) {
    serialized.__truncated = true;
  }
  return serialized;
}

function serializeErrorValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (!isObjectValue(value)) {
    return serializeNonObjectValue(value);
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
    return serializeDateValue(value);
  }
  if (value instanceof RegExp) {
    return safeString(value);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return serializeArrayValue(value, seen, depth);
  }
  return serializePlainObjectValue(value, seen, depth);
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
