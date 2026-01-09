#!/usr/bin/env tsx
/**
 * OpenAPI Specification Generator
 *
 * Generates OpenAPI 3.0 specification from ts-rest public API contracts.
 *
 * Usage:
 *   pnpm --filter @vm0/web generate-openapi
 *
 * Output:
 *   apps/web/public/openapi.json
 */
import { generateOpenApi } from "@ts-rest/open-api";
import { publicApiContract } from "@vm0/core";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Generate OpenAPI specification
const openApiDocument = generateOpenApi(
  publicApiContract,
  {
    info: {
      title: "vm0 Public API",
      version: "1.0.0",
      description: `
The vm0 Public API provides programmatic access to the vm0 platform for building,
running, and managing AI agents.

## Authentication

All API requests require authentication using an API token. Include your token
in the Authorization header:

\`\`\`
Authorization: Bearer vm0_live_xxxxxxxxxxxx
\`\`\`

You can create and manage API tokens at [vm0.dev/settings/tokens](https://vm0.dev/settings/tokens)
or via the \`/v1/tokens\` endpoints.

## Rate Limits

API requests are rate limited. Current limits are returned in response headers:

- \`X-RateLimit-Limit\`: Maximum requests per hour
- \`X-RateLimit-Remaining\`: Remaining requests in current window
- \`X-RateLimit-Reset\`: Unix timestamp when the limit resets

## Error Handling

All errors follow a consistent format:

\`\`\`json
{
  "error": {
    "type": "invalid_request_error",
    "code": "missing_parameter",
    "message": "Missing required parameter: name"
  }
}
\`\`\`

Error types:
- \`api_error\` - Internal server error (5xx)
- \`invalid_request_error\` - Bad request parameters (400)
- \`authentication_error\` - Authentication failure (401)
- \`not_found_error\` - Resource not found (404)
- \`conflict_error\` - Resource conflict (409)

## Pagination

List endpoints use cursor-based pagination:

\`\`\`json
{
  "data": [...],
  "pagination": {
    "has_more": true,
    "next_cursor": "xxx"
  }
}
\`\`\`

Use the \`cursor\` query parameter with the \`next_cursor\` value to fetch the next page.
      `.trim(),
      contact: {
        name: "vm0 Support",
        url: "https://vm0.dev/support",
        email: "support@vm0.dev",
      },
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    servers: [
      {
        url: "https://api.vm0.dev",
        description: "Production",
      },
      {
        url: "https://staging.api.vm0.dev",
        description: "Staging",
      },
      {
        url: "http://localhost:3000",
        description: "Local Development",
      },
    ],
    // Security schemes
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Token",
          description:
            "API token authentication. Format: vm0_live_xxxxxxxxxxxx",
        },
      },
    },
    // Apply security globally
    security: [
      {
        bearerAuth: [],
      },
    ],
    // Tags for grouping endpoints
    tags: [
      {
        name: "Agents",
        description: "Create, manage, and deploy AI agents",
      },
      {
        name: "Runs",
        description: "Execute agents and monitor run status",
      },
      {
        name: "Artifacts",
        description: "Store and retrieve agent work products",
      },
      {
        name: "Volumes",
        description: "Manage input data volumes for agents",
      },
      {
        name: "Tokens",
        description: "Self-service API token management",
      },
    ],
    // External documentation
    externalDocs: {
      description: "Full API Documentation",
      url: "https://docs.vm0.dev/api",
    },
  },
  // Generation options
  {
    setOperationId: true,
    jsonQuery: true,
  },
);

// Add tags to operations based on path
function addTagsToOperations(doc: Record<string, unknown>): void {
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  if (!paths) return;

  for (const [path, methods] of Object.entries(paths)) {
    for (const [, operation] of Object.entries(methods)) {
      if (typeof operation !== "object" || operation === null) continue;
      const op = operation as Record<string, unknown>;

      // Assign tags based on path prefix
      if (path.startsWith("/v1/agents")) {
        op.tags = ["Agents"];
      } else if (path.startsWith("/v1/runs")) {
        op.tags = ["Runs"];
      } else if (path.startsWith("/v1/artifacts")) {
        op.tags = ["Artifacts"];
      } else if (path.startsWith("/v1/volumes")) {
        op.tags = ["Volumes"];
      } else if (path.startsWith("/v1/tokens")) {
        op.tags = ["Tokens"];
      }
    }
  }
}

// Post-process the document
addTagsToOperations(openApiDocument as Record<string, unknown>);

// Write to file
const outputPath = join(__dirname, "../public/openapi.json");
writeFileSync(outputPath, JSON.stringify(openApiDocument, null, 2));

console.log(`✅ OpenAPI specification generated: ${outputPath}`);
console.log(
  `   Endpoints: ${Object.keys((openApiDocument as Record<string, unknown>).paths ?? {}).length}`,
);
