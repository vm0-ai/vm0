import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testMcpOAuthFetchRequestSchema = z.object({
  url: z.url(),
  method: z.enum(["GET", "HEAD", "POST"]),
  bodyKind: z.enum(["form", "json"]).optional(),
  body: z.string().optional(),
  authorization: z.string().optional(),
  cancel: z.boolean().optional(),
});
export type TestMcpOAuthFetchRequest = z.infer<
  typeof testMcpOAuthFetchRequestSchema
>;

export const testMcpOAuthFetchContract = c.router({
  request: {
    method: "POST",
    path: "/api/test/mcp-oauth-fetch",
    body: testMcpOAuthFetchRequestSchema,
    responses: {
      200: z.object({
        status: z.number().int(),
        headers: z.record(z.string(), z.string()),
        body: z.string(),
      }),
      404: z.string(),
      502: z.object({ error: z.string() }),
    },
    summary: "Probe the MCP OAuth fetch policy in API tests",
  },
});
