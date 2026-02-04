import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Secret name validation
 * Rules:
 * - 1-255 characters
 * - uppercase letters, numbers, and underscores only
 * - must start with a letter
 * Examples: MY_API_KEY, GITHUB_TOKEN, AWS_ACCESS_KEY_ID
 */
export const secretNameSchema = z
  .string()
  .min(1, "Secret name is required")
  .max(255, "Secret name must be at most 255 characters")
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    "Secret name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
  );

/**
 * Secret type schema
 */
export const secretTypeSchema = z.enum(["user", "model-provider"]);

export type SecretType = z.infer<typeof secretTypeSchema>;

/**
 * Secret metadata response (value is never returned)
 */
export const secretResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  type: secretTypeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SecretResponse = z.infer<typeof secretResponseSchema>;

/**
 * List secrets response
 */
export const secretListResponseSchema = z.object({
  secrets: z.array(secretResponseSchema),
});

export type SecretListResponse = z.infer<typeof secretListResponseSchema>;

/**
 * Set secret request (create or update)
 */
export const setSecretRequestSchema = z.object({
  name: secretNameSchema,
  value: z.string().min(1, "Secret value is required"),
  description: z.string().max(1000).optional(),
});

export type SetSecretRequest = z.infer<typeof setSecretRequestSchema>;

/**
 * Secrets contract for /api/secrets
 */
export const secretsMainContract = c.router({
  /**
   * GET /api/secrets
   * List all secrets for the current user's scope (metadata only)
   */
  list: {
    method: "GET",
    path: "/api/secrets",
    headers: authHeadersSchema,
    responses: {
      200: secretListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all secrets (metadata only)",
  },

  /**
   * PUT /api/secrets
   * Create or update a secret
   */
  set: {
    method: "PUT",
    path: "/api/secrets",
    headers: authHeadersSchema,
    body: setSecretRequestSchema,
    responses: {
      200: secretResponseSchema,
      201: secretResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update a secret",
  },
});

export type SecretsMainContract = typeof secretsMainContract;

/**
 * Secrets by name contract for /api/secrets/[name]
 */
export const secretsByNameContract = c.router({
  /**
   * GET /api/secrets/:name
   * Get a secret by name (metadata only)
   */
  get: {
    method: "GET",
    path: "/api/secrets/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: secretNameSchema,
    }),
    responses: {
      200: secretResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get secret metadata by name",
  },

  /**
   * DELETE /api/secrets/:name
   * Delete a secret by name
   */
  delete: {
    method: "DELETE",
    path: "/api/secrets/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: secretNameSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a secret",
  },
});

export type SecretsByNameContract = typeof secretsByNameContract;
