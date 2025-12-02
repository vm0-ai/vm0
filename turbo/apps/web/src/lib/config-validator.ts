/**
 * Extract all ${{ vars.xxx }} template variable references from a config object
 * @param obj - Config object that may contain template variables
 * @returns Array of unique template variable names (just the name, not full syntax)
 */
export function extractTemplateVars(obj: unknown): string[] {
  const templateVars = new Set<string>();

  function scan(value: unknown): void {
    if (typeof value === "string") {
      // Match ${{ vars.varName }} syntax
      const matches = value.matchAll(/\$\{\{\s*vars\.(\w+)\s*\}\}/g);
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
