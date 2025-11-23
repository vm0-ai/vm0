/**
 * Extract all unexpanded environment variable references from a config object
 * Supports ${VAR} syntax
 * @param obj - Config object that may contain unexpanded environment variables
 * @returns Array of unexpanded variable references (with ${} syntax)
 */
export function extractUnexpandedVars(obj: unknown): string[] {
  const unexpandedVars = new Set<string>();

  function scan(value: unknown): void {
    if (typeof value === "string") {
      const matches = value.matchAll(/\$\{([^}]+)\}/g);
      for (const match of matches) {
        unexpandedVars.add(match[0]); // Keep full ${VAR} syntax
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
  return Array.from(unexpandedVars);
}

/**
 * Extract all template variable references from a config object
 * Supports {{VAR}} syntax
 * @param obj - Config object that may contain template variables
 * @returns Array of unique template variable names
 */
export function extractTemplateVars(obj: unknown): string[] {
  const templateVars = new Set<string>();

  function scan(value: unknown): void {
    if (typeof value === "string") {
      const matches = value.matchAll(/\{\{([^}]+)\}\}/g);
      for (const match of matches) {
        const varName = match[1];
        if (varName) {
          templateVars.add(varName);
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
  return Array.from(templateVars);
}
