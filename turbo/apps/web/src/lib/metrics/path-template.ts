// UUID pattern
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Known route patterns
const ROUTE_PATTERNS: Array<{ pattern: RegExp; template: string }> = [
  // Public API v1
  { pattern: /^\/v1\/runs\/[^/]+$/, template: "/v1/runs/:id" },
  { pattern: /^\/v1\/runs\/[^/]+\/events$/, template: "/v1/runs/:id/events" },
  { pattern: /^\/v1\/runs\/[^/]+\/metrics$/, template: "/v1/runs/:id/metrics" },
  { pattern: /^\/v1\/agents\/[^/]+$/, template: "/v1/agents/:id" },
  { pattern: /^\/v1\/artifacts\/[^/]+$/, template: "/v1/artifacts/:id" },
  { pattern: /^\/v1\/volumes\/[^/]+$/, template: "/v1/volumes/:id" },
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
