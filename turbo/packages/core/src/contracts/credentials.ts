import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Credential name validation
 * Rules:
 * - 1-255 characters
 * - uppercase letters, numbers, and underscores only
 * - must start with a letter
 * Examples: MY_API_KEY, GITHUB_TOKEN, AWS_ACCESS_KEY_ID
 */
export const credentialNameSchema = z
  .string()
  .min(1, "Credential name is required")
  .max(255, "Credential name must be at most 255 characters")
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    "Credential name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
  );

/**
 * Credential type schema
 */
export const credentialTypeSchema = z.enum(["user", "model-provider"]);

export type CredentialType = z.infer<typeof credentialTypeSchema>;

/**
 * Credential metadata response (value is never returned)
 */
export const credentialResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  type: credentialTypeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CredentialResponse = z.infer<typeof credentialResponseSchema>;

/**
 * List credentials response
 */
export const credentialListResponseSchema = z.object({
  credentials: z.array(credentialResponseSchema),
});

export type CredentialListResponse = z.infer<
  typeof credentialListResponseSchema
>;

/**
 * Set credential request (create or update)
 */
export const setCredentialRequestSchema = z.object({
  name: credentialNameSchema,
  value: z.string().min(1, "Credential value is required"),
  description: z.string().max(1000).optional(),
});

export type SetCredentialRequest = z.infer<typeof setCredentialRequestSchema>;

/**
 * Credentials contract for /api/credentials
 */
export const credentialsMainContract = c.router({
  /**
   * GET /api/credentials
   * List all credentials for the current user's scope (metadata only)
   */
  list: {
    method: "GET",
    path: "/api/credentials",
    headers: authHeadersSchema,
    responses: {
      200: credentialListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all credentials (metadata only)",
  },

  /**
   * PUT /api/credentials
   * Create or update a credential
   */
  set: {
    method: "PUT",
    path: "/api/credentials",
    headers: authHeadersSchema,
    body: setCredentialRequestSchema,
    responses: {
      200: credentialResponseSchema,
      201: credentialResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update a credential",
  },
});

export type CredentialsMainContract = typeof credentialsMainContract;

/**
 * Credentials by name contract for /api/credentials/[name]
 */
export const credentialsByNameContract = c.router({
  /**
   * GET /api/credentials/:name
   * Get a credential by name (metadata only)
   */
  get: {
    method: "GET",
    path: "/api/credentials/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: credentialNameSchema,
    }),
    responses: {
      200: credentialResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get credential metadata by name",
  },

  /**
   * DELETE /api/credentials/:name
   * Delete a credential by name
   */
  delete: {
    method: "DELETE",
    path: "/api/credentials/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: credentialNameSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a credential",
  },
});

export type CredentialsByNameContract = typeof credentialsByNameContract;
