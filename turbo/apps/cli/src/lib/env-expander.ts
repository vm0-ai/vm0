/**
 * Expand environment variables in a string
 * Supports ${VAR} syntax
 * @param value - String that may contain environment variables
 * @returns String with environment variables expanded
 */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? "";
  });
}

/**
 * Recursively expand environment variables in an object
 * @param obj - Object that may contain environment variables in string values
 * @returns Object with environment variables expanded
 */
export function expandEnvVarsInObject(obj: unknown): unknown {
  if (typeof obj === "string") {
    return expandEnvVars(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVarsInObject(item));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value);
    }
    return result;
  }

  return obj;
}
