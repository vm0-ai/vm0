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
 * Extract all environment variable references from a value
 * Supports ${VAR} syntax
 * @param value - String that may contain environment variable references
 * @returns Array of unique variable names
 */
export function extractEnvVarReferences(obj: unknown): string[] {
  const varNames = new Set<string>();

  function scan(value: unknown): void {
    if (typeof value === "string") {
      const matches = value.matchAll(/\$\{([^}]+)\}/g);
      for (const match of matches) {
        const varName = match[1];
        if (varName) {
          varNames.add(varName);
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        scan(item);
      }
    } else if (value !== null && typeof value === "object") {
      for (const val of Object.values(value)) {
        scan(val);
      }
    }
  }

  scan(obj);
  return Array.from(varNames);
}

/**
 * Validate that all required environment variables are defined
 * @param varNames - Array of environment variable names to check
 * @returns Array of missing variable names
 */
export function validateEnvVars(varNames: string[]): string[] {
  const missing: string[] = [];

  for (const varName of varNames) {
    if (process.env[varName] === undefined) {
      missing.push(varName);
    }
  }

  return missing;
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
