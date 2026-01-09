/**
 * Public API v1 - Tokens Contract
 *
 * Token management endpoints for self-service API token creation and revocation.
 */
import { z } from "zod";
import { initContract } from "../base";
import {
  publicApiErrorSchema,
  createPaginatedResponseSchema,
  listQuerySchema,
  timestampSchema,
} from "./common";

const c = initContract();

/**
 * Token schema for public API responses (does not include secret)
 */
export const publicTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  token_prefix: z.string(), // First 12 chars for identification (e.g., "vm0_live_abc")
  last_used_at: timestampSchema.nullable(),
  expires_at: timestampSchema,
  created_at: timestampSchema,
});

export type PublicToken = z.infer<typeof publicTokenSchema>;

/**
 * Token detail schema with full token value (only on creation)
 */
export const publicTokenDetailSchema = publicTokenSchema.extend({
  token: z.string().optional(), // Full token value, only returned on creation
});

export type PublicTokenDetail = z.infer<typeof publicTokenDetailSchema>;

/**
 * Paginated tokens response
 */
export const paginatedTokensSchema =
  createPaginatedResponseSchema(publicTokenSchema);

/**
 * Create token request schema
 */
export const createTokenRequestSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  expires_in_days: z.number().min(1).max(365).optional(), // null for no expiry (default 90 days)
});

export type CreateTokenRequest = z.infer<typeof createTokenRequestSchema>;

/**
 * Tokens List Contract
 *
 * GET /v1/tokens - List user's API tokens
 */
export const publicTokensListContract = c.router({
  list: {
    method: "GET",
    path: "/v1/tokens",
    query: listQuerySchema,
    responses: {
      200: paginatedTokensSchema,
      401: publicApiErrorSchema,
    },
    summary: "List API tokens",
    description: "List all API tokens for the authenticated user",
  },
  create: {
    method: "POST",
    path: "/v1/tokens",
    body: createTokenRequestSchema,
    responses: {
      201: publicTokenDetailSchema, // Includes full token value
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
    },
    summary: "Create API token",
    description:
      "Create a new API token. The token value is only returned once on creation.",
  },
});

export type PublicTokensListContract = typeof publicTokensListContract;

/**
 * Token by ID Contract
 *
 * GET /v1/tokens/:id - Get token details (without secret)
 * DELETE /v1/tokens/:id - Revoke token
 */
export const publicTokenByIdContract = c.router({
  get: {
    method: "GET",
    path: "/v1/tokens/:id",
    pathParams: z.object({
      id: z.string(),
    }),
    responses: {
      200: publicTokenSchema, // Does NOT include token value
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
    },
    summary: "Get API token",
    description:
      "Get details of an API token (does not include the token value)",
  },
  delete: {
    method: "DELETE",
    path: "/v1/tokens/:id",
    pathParams: z.object({
      id: z.string(),
    }),
    responses: {
      204: z.undefined(),
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
    },
    summary: "Revoke API token",
    description:
      "Permanently revoke an API token. This action cannot be undone.",
  },
});

export type PublicTokenByIdContract = typeof publicTokenByIdContract;
