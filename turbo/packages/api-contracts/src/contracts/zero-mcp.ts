import { z } from "zod";
import {
  firewallMcpToolNameSchema,
  firewallMcpToolPolicySchema,
  MCP_TOOL_NAME_MAX_LENGTH,
  MCP_TOOL_POLICY_MAX_EXACT_NAMES,
} from "@vm0/connectors/firewall-types";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MCP_SERVER_REF_MAX_LENGTH = 64;
export const MCP_SERVER_DISPLAY_NAME_MAX_LENGTH = 128;
export const MCP_SERVER_ENDPOINT_MAX_LENGTH = 2048;
export const MCP_AGENT_GRANT_MAX_SERVERS = 32;
export const MCP_AGENT_GRANT_MAX_TOOL_NAMES = MCP_TOOL_POLICY_MAX_EXACT_NAMES;
export { MCP_TOOL_NAME_MAX_LENGTH };
export const MCP_AGENT_GRANTS_MAX_ENCODED_BYTES = 64 * 1024;

const MCP_SERVER_REF_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const UTF8_ENCODER = new TextEncoder();

export const mcpServerRefSchema = z
  .string()
  .min(1)
  .max(MCP_SERVER_REF_MAX_LENGTH)
  .regex(
    MCP_SERVER_REF_PATTERN,
    "Server ref must use lowercase letters, numbers, and internal hyphens",
  );

export const mcpServerResponseSchema = z
  .object({
    ref: mcpServerRefSchema,
    displayName: z.string().min(1).max(MCP_SERVER_DISPLAY_NAME_MAX_LENGTH),
    endpoint: z.string().min(1).max(MCP_SERVER_ENDPOINT_MAX_LENGTH),
    enabled: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type McpServerResponse = z.infer<typeof mcpServerResponseSchema>;

export const createMcpServerBodySchema = z
  .object({
    ref: mcpServerRefSchema,
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(MCP_SERVER_DISPLAY_NAME_MAX_LENGTH),
    endpoint: z.string().min(1).max(MCP_SERVER_ENDPOINT_MAX_LENGTH),
    enabled: z.boolean(),
  })
  .strict();
export type CreateMcpServerBody = z.infer<typeof createMcpServerBodySchema>;

export const patchMcpServerBodySchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(MCP_SERVER_DISPLAY_NAME_MAX_LENGTH)
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => {
      return body.displayName !== undefined || body.enabled !== undefined;
    },
    { message: "At least one mutable field is required" },
  );
export type PatchMcpServerBody = z.infer<typeof patchMcpServerBodySchema>;

export const mcpToolNameSchema = firewallMcpToolNameSchema;
export const mcpToolPolicySchema = firewallMcpToolPolicySchema;
export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>;

export const mcpAgentGrantSchema = z
  .object({
    serverRef: mcpServerRefSchema,
    toolPolicy: mcpToolPolicySchema,
  })
  .strict();
export type McpAgentGrant = z.infer<typeof mcpAgentGrantSchema>;

export const mcpAgentGrantsResponseSchema = z
  .object({
    grants: z.array(mcpAgentGrantSchema),
  })
  .strict();
export type McpAgentGrantsResponse = z.infer<
  typeof mcpAgentGrantsResponseSchema
>;

export const replaceMcpAgentGrantsBodySchema = z
  .object({
    grants: z.array(mcpAgentGrantSchema).max(MCP_AGENT_GRANT_MAX_SERVERS),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    for (const [index, grant] of body.grants.entries()) {
      if (seen.has(grant.serverRef)) {
        ctx.addIssue({
          code: "custom",
          path: ["grants", index, "serverRef"],
          message: `Duplicate MCP server ref: ${grant.serverRef}`,
        });
      }
      seen.add(grant.serverRef);
    }

    const encodedBytes = UTF8_ENCODER.encode(
      JSON.stringify(body.grants),
    ).byteLength;
    if (encodedBytes > MCP_AGENT_GRANTS_MAX_ENCODED_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["grants"],
        message: `MCP grant policy must not exceed ${MCP_AGENT_GRANTS_MAX_ENCODED_BYTES} UTF-8 bytes`,
      });
    }
  });
export type ReplaceMcpAgentGrantsBody = z.infer<
  typeof replaceMcpAgentGrantsBodySchema
>;

const mcpServerListResponseSchema = z
  .object({
    servers: z.array(mcpServerResponseSchema),
  })
  .strict();

const mcpServerRefPathParamsSchema = z.object({
  ref: mcpServerRefSchema,
});

const mcpAgentPathParamsSchema = z.object({
  id: z.string().uuid(),
});

export const zeroMcpServersContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/mcp/servers",
    headers: authHeadersSchema,
    responses: {
      200: mcpServerListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List organization MCP servers",
  },
  create: {
    method: "POST",
    path: "/api/zero/mcp/servers",
    headers: authHeadersSchema,
    body: createMcpServerBodySchema,
    responses: {
      201: mcpServerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create an organization MCP server",
  },
});
export type ZeroMcpServersContract = typeof zeroMcpServersContract;

export const zeroMcpServerByRefContract = c.router({
  patch: {
    method: "PATCH",
    path: "/api/zero/mcp/servers/:ref",
    headers: authHeadersSchema,
    pathParams: mcpServerRefPathParamsSchema,
    body: patchMcpServerBodySchema,
    responses: {
      200: mcpServerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update mutable MCP server fields",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/mcp/servers/:ref",
    headers: authHeadersSchema,
    pathParams: mcpServerRefPathParamsSchema,
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an organization MCP server",
  },
});
export type ZeroMcpServerByRefContract = typeof zeroMcpServerByRefContract;

export const zeroAgentMcpGrantsContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:id/mcp-grants",
    headers: authHeadersSchema,
    pathParams: mcpAgentPathParamsSchema,
    responses: {
      200: mcpAgentGrantsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get MCP grants for an owned agent",
  },
  replace: {
    method: "PUT",
    path: "/api/zero/agents/:id/mcp-grants",
    headers: authHeadersSchema,
    pathParams: mcpAgentPathParamsSchema,
    body: replaceMcpAgentGrantsBodySchema,
    responses: {
      200: mcpAgentGrantsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Replace MCP grants for an owned agent",
  },
});
export type ZeroAgentMcpGrantsContract = typeof zeroAgentMcpGrantsContract;
