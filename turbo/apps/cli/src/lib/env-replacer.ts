/**
 * Replace environment variable placeholders in config
 * Supports ${VAR_NAME} format
 */

interface EnvReplacementResult {
  config: unknown;
  errors: string[];
}

/**
 * Recursively replace ${VAR} placeholders with environment variable values
 */
export function replaceEnvVars(obj: unknown): EnvReplacementResult {
  const errors: string[] = [];

  function replace(value: unknown): unknown {
    // Handle strings
    if (typeof value === "string") {
      // Match ${VAR_NAME} pattern
      const pattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
      const matches = [...value.matchAll(pattern)];

      if (matches.length === 0) {
        return value;
      }

      let result = value;
      for (const match of matches) {
        const varName = match[1]!;
        const envValue = process.env[varName];

        if (envValue === undefined) {
          errors.push(
            `Environment variable not found: ${varName} (referenced as \${${varName}})`,
          );
          // Keep placeholder unchanged if env var not found
          continue;
        }

        result = result.replace(match[0]!, envValue);
      }

      return result;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item) => replace(item));
    }

    // Handle objects
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = replace(val);
      }
      return result;
    }

    // Return primitives unchanged
    return value;
  }

  const config = replace(obj);

  return { config, errors };
}
