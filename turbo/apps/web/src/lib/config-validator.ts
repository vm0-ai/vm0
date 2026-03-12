import { extractAndGroupVariables } from "@vm0/core";

/**
 * Extract all ${{ vars.xxx }} template variable references from a config object
 * Uses core library's unified variable extraction
 * @param obj - Config object that may contain template variables
 * @returns Array of unique template variable names (just the name, not full syntax)
 */
export function extractTemplateVars(obj: unknown): string[] {
  const grouped = extractAndGroupVariables(obj);
  return grouped.vars.map((ref) => ref.name);
}
