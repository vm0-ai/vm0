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
export function serializeError(err: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  if (err.cause !== undefined) {
    serialized.cause =
      err.cause instanceof Error ? serializeError(err.cause) : err.cause;
  }
  for (const [key, value] of Object.entries(err)) {
    if (!(key in serialized)) {
      serialized[key] = value;
    }
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
