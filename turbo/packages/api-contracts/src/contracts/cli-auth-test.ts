import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

const testEmailQuerySchema = z.object({
  email: z.string().optional(),
});

const stringErrorResponseSchema = z.object({
  error: z.string(),
});

const notFoundTextSchema = z.string();

export const cliAuthTestApproveContract = c.router({
  approve: {
    method: "POST",
    path: "/api/cli/auth/test-approve",
    query: testEmailQuerySchema,
    body: z.object({
      device_code: z.string().optional(),
    }),
    responses: {
      200: z.object({ success: z.literal(true), userId: z.string() }),
      400: stringErrorResponseSchema,
      404: notFoundTextSchema,
    },
    summary: "Approve a CLI auth device code for tests",
  },
});

export const cliAuthTestTokenContract = c.router({
  create: {
    method: "POST",
    path: "/api/cli/auth/test-token",
    query: testEmailQuerySchema,
    body: z.object({}).optional(),
    responses: {
      200: z.object({
        access_token: z.string(),
        token_type: z.literal("Bearer"),
        expires_in: z.number(),
        user_id: z.string(),
      }),
      404: notFoundTextSchema,
    },
    summary: "Create a CLI auth token for tests",
  },
});

export const cliAuthTestConnectorContract = c.router({
  create: {
    method: "POST",
    path: "/api/cli/auth/test-connector",
    query: testEmailQuerySchema,
    body: z.object({
      connectorName: z.string(),
      accessToken: z.string(),
      refreshToken: z.string().min(1).optional(),
      expiresIn: z.number().int().optional(),
    }),
    responses: {
      200: z.object({
        ok: z.literal(true),
        connectorType: z.string(),
        orgId: z.string(),
      }),
      400: stringErrorResponseSchema,
      404: notFoundTextSchema.or(stringErrorResponseSchema),
    },
    summary: "Seed an OAuth connector for tests",
  },
});

export const cliAuthTestEnableConnectorContract = c.router({
  create: {
    method: "POST",
    path: "/api/cli/auth/test-enable-connector",
    query: testEmailQuerySchema,
    body: z.object({
      composeId: z.string().uuid(),
      connectorTypes: z.array(z.string()).min(1),
    }),
    responses: {
      200: z.object({
        ok: z.literal(true),
        composeId: z.string(),
        connectorTypes: z.array(z.string()),
      }),
      400: stringErrorResponseSchema,
      404: notFoundTextSchema.or(stringErrorResponseSchema),
    },
    summary: "Enable connector rows for a test compose",
  },
});

const codexLegacyBodySchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accountId: z.string().min(1),
  idToken: z.string().min(1),
  expiresIn: z.number().int().optional(),
  needsReconnect: z.boolean().optional(),
  lastRefreshErrorCode: z.string().nullable().optional(),
});

const codexAuthJsonBodySchema = z.object({
  authJson: z.string().min(1),
});

export const cliAuthTestCodexOauthContract = c.router({
  create: {
    method: "POST",
    path: "/api/cli/auth/test-codex-oauth",
    query: testEmailQuerySchema,
    body: z.union([codexAuthJsonBodySchema, codexLegacyBodySchema]),
    responses: {
      200: z.object({
        ok: z.literal(true).optional(),
        orgId: z.string(),
        tokenExpiresAt: z.string().optional(),
      }),
      400: stringErrorResponseSchema,
      404: notFoundTextSchema,
    },
    summary: "Seed Codex OAuth model provider state for tests",
  },
});

export type CliAuthTestApproveContract = typeof cliAuthTestApproveContract;
export type CliAuthTestTokenContract = typeof cliAuthTestTokenContract;
export type CliAuthTestConnectorContract = typeof cliAuthTestConnectorContract;
export type CliAuthTestEnableConnectorContract =
  typeof cliAuthTestEnableConnectorContract;
export type CliAuthTestCodexOauthContract =
  typeof cliAuthTestCodexOauthContract;
