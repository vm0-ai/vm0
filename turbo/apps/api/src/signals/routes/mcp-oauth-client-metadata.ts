import { mcpOAuthContract } from "@okouai/api-contracts/contracts/mcp-oauth";
import { computed } from "ccstate";

import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { okouMcpOAuthClientMetadata } from "../services/mcp-oauth-client-metadata.service";

const okouClientMetadata$ = computed((get) => {
  return {
    status: 200 as const,
    body: okouMcpOAuthClientMetadata(get(request$).raw),
  };
});

export const mcpOAuthClientMetadataRoutes: readonly RouteEntry[] = [
  {
    route: mcpOAuthContract.okouClientMetadata,
    handler: okouClientMetadata$,
  },
];
