/**
 * Unified variable expansion for agent compose configurations
 * Supports ${{ vars.xxx }}, ${{ secrets.xxx }}, and ${{ credentials.xxx }} syntax
 * Note: ${{ env.xxx }} is parsed but not currently used (reserved for future)
 *
 * Migration note: ${{ credentials.X }} can resolve from either credentials or secrets source.
 * The credentials source is checked first, then secrets as fallback. This allows existing
 * credential references to continue working while also enabling migration to secrets.
 */

/**
 * Variable reference with source and name
 */
export interface VariableReference {
  source: "env" | "vars" | "secrets" | "credentials";
  name: string;
  fullMatch: string;
}

/**
 * Sources for variable expansion
 */
export interface VariableSources {
  env?: Record<string, string | undefined>;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  credentials?: Record<string, string>;
}

/**
 * Result of variable expansion
 */
export interface ExpansionResult<T> {
  result: T;
  missingVars: VariableReference[];
}

/**
 * Regex pattern for ${{ source.name }} syntax
 * Matches: ${{ env.VAR }}, ${{ vars.foo }}, ${{ secrets.key }}, ${{ credentials.KEY }}
 */
const VARIABLE_PATTERN =
  /\$\{\{\s*(env|vars|secrets|credentials)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Extract all variable references from a string
 * @param value - String that may contain variable references
 * @returns Array of variable references found
 */
export function extractVariableReferencesFromString(
  value: string,
): VariableReference[] {
  const refs: VariableReference[] = [];
  const matches = value.matchAll(VARIABLE_PATTERN);

  for (const match of matches) {
    const source = match[1] as "env" | "vars" | "secrets" | "credentials";
    const name = match[2]!;
    refs.push({
      source,
      name,
      fullMatch: match[0]!,
    });
  }

  return refs;
}

/**
 * Extract all variable references from an object recursively
 * @param obj - Object that may contain variable references in string values
 * @returns Array of unique variable references
 */
export function extractVariableReferences(obj: unknown): VariableReference[] {
  const refs: VariableReference[] = [];
  const seen = new Set<string>();

  function scan(value: unknown): void {
    if (typeof value === "string") {
      const stringRefs = extractVariableReferencesFromString(value);
      for (const ref of stringRefs) {
        const key = `${ref.source}.${ref.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push(ref);
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
  return refs;
}

/**
 * Expand variables in a string using provided sources
 * @param value - String that may contain variable references
 * @param sources - Sources for variable values
 * @returns Expansion result with resolved string and missing variables
 */
export function expandVariablesInString(
  value: string,
  sources: VariableSources,
): ExpansionResult<string> {
  const missingVars: VariableReference[] = [];
  const seenMissing = new Set<string>();

  const result = value.replace(VARIABLE_PATTERN, (fullMatch, source, name) => {
    const typedSource = source as "env" | "vars" | "secrets" | "credentials";

    // For credentials, check credentials source first, then fall back to secrets
    // This allows ${{ credentials.X }} to resolve from either source
    let resolved: string | undefined;
    if (typedSource === "credentials") {
      resolved = sources.credentials?.[name] ?? sources.secrets?.[name];
    } else {
      resolved = sources[typedSource]?.[name];
    }

    if (resolved === undefined) {
      const key = `${typedSource}.${name}`;
      if (!seenMissing.has(key)) {
        seenMissing.add(key);
        missingVars.push({ source: typedSource, name, fullMatch });
      }
      return fullMatch;
    }

    return resolved;
  });

  return { result, missingVars };
}

/**
 * Recursively expand variables in an object
 * @param obj - Object that may contain variable references in string values
 * @param sources - Sources for variable values
 * @returns Expansion result with resolved object and missing variables
 */
export function expandVariables<T>(
  obj: T,
  sources: VariableSources,
): ExpansionResult<T> {
  const allMissingVars: VariableReference[] = [];
  const seenMissing = new Set<string>();

  function expand(value: unknown): unknown {
    if (typeof value === "string") {
      const { result, missingVars } = expandVariablesInString(value, sources);
      for (const missing of missingVars) {
        const key = `${missing.source}.${missing.name}`;
        if (!seenMissing.has(key)) {
          seenMissing.add(key);
          allMissingVars.push(missing);
        }
      }
      return result;
    }

    if (Array.isArray(value)) {
      return value.map((item) => expand(item));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = expand(val);
      }
      return result;
    }

    return value;
  }

  const result = expand(obj) as T;
  return { result, missingVars: allMissingVars };
}

/**
 * Validate that all required variables have values in sources
 * @param refs - Array of variable references to validate
 * @param sources - Sources for variable values
 * @returns Array of missing variable references
 */
export function validateRequiredVariables(
  refs: VariableReference[],
  sources: VariableSources,
): VariableReference[] {
  const missing: VariableReference[] = [];

  for (const ref of refs) {
    // For credentials, check credentials source first, then fall back to secrets
    let resolved: string | undefined;
    if (ref.source === "credentials") {
      resolved = sources.credentials?.[ref.name] ?? sources.secrets?.[ref.name];
    } else {
      resolved = sources[ref.source]?.[ref.name];
    }
    if (resolved === undefined) {
      missing.push(ref);
    }
  }

  return missing;
}

/**
 * Group variable references by source
 * @param refs - Array of variable references
 * @returns Object with arrays grouped by source
 */
export function groupVariablesBySource(refs: VariableReference[]): {
  env: VariableReference[];
  vars: VariableReference[];
  secrets: VariableReference[];
  credentials: VariableReference[];
} {
  const groups = {
    env: [] as VariableReference[],
    vars: [] as VariableReference[],
    secrets: [] as VariableReference[],
    credentials: [] as VariableReference[],
  };

  for (const ref of refs) {
    groups[ref.source].push(ref);
  }

  return groups;
}

/**
 * Format missing variables for error messages
 * @param missing - Array of missing variable references
 * @returns Formatted error message
 */
export function formatMissingVariables(missing: VariableReference[]): string {
  const grouped = groupVariablesBySource(missing);
  const messages: string[] = [];

  if (grouped.env.length > 0) {
    const names = grouped.env.map((r) => r.name).join(", ");
    messages.push(`Environment variables: ${names}`);
  }

  if (grouped.vars.length > 0) {
    const names = grouped.vars.map((r) => r.name).join(", ");
    messages.push(`CLI variables (--vars): ${names}`);
  }

  if (grouped.secrets.length > 0) {
    const names = grouped.secrets.map((r) => r.name).join(", ");
    messages.push(`Secrets: ${names}`);
  }

  if (grouped.credentials.length > 0) {
    const names = grouped.credentials.map((r) => r.name).join(", ");
    messages.push(`Credentials: ${names}`);
  }

  return messages.join("\n");
}
