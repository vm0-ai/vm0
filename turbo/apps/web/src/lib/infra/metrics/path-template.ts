// UUID pattern
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Known route patterns
const ROUTE_PATTERNS: Array<{ pattern: RegExp; template: string }> = [
  // Internal API
  { pattern: /^\/api\/agent\/runs\/[^/]+$/, template: "/api/agent/runs/:id" },
  {
    pattern: /^\/api\/agent\/runs\/[^/]+\//,
    template: "/api/agent/runs/:id/*",
  },
  { pattern: /^\/api\/compose\/[^/]+$/, template: "/api/compose/:id" },
  { pattern: /^\/api\/compose\/[^/]+\//, template: "/api/compose/:id/*" },
];

export function pathToTemplate(path: string): string {
  // Try known patterns first
  for (const { pattern, template } of ROUTE_PATTERNS) {
    if (pattern.test(path)) {
      return template;
    }
  }

  // Fallback: replace UUIDs with :id
  return path.replace(UUID_PATTERN, ":id");
}
