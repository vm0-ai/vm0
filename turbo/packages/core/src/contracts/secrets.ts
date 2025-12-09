import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Secret name validation schema
 * - Must start with a letter
 * - Can only contain letters, numbers, and underscores
 * - Maximum 255 characters
 */
const secretNameSchema = z
  .string()
  .min(1, "Secret name is required")
  .max(255, "Secret name must be 255 characters or less")
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]*$/,
    "Secret name must start with a letter and contain only letters, numbers, and underscores",
  );

/**
 * Secret value validation schema
 * Maximum 48 KB (same as GitHub Actions secrets)
 */
const secretValueSchema = z
  .string()
  .min(1, "Secret value is required")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 48 * 1024,
    "Secret value must be 48 KB or less",
  );

/**
 * Secret info response schema (returned when listing secrets)
 */
const secretInfoSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Secrets API contract
 * Defines the endpoints for managing user secrets
 */
export const secretsContract = c.router({
  /**
   * GET /api/secrets
   * List all secrets for the authenticated user (names only, not values)
   */
  list: {
    method: "GET",
    path: "/api/secrets",
    responses: {
      200: z.object({
        secrets: z.array(secretInfoSchema),
      }),
      401: apiErrorSchema,
    },
    summary: "List all secrets",
  },

  /**
   * POST /api/secrets
   * Create or update a secret
   */
  create: {
    method: "POST",
    path: "/api/secrets",
    body: z.object({
      name: secretNameSchema,
      value: secretValueSchema,
    }),
    responses: {
      200: z.object({
        name: z.string(),
        action: z.literal("updated"),
      }),
      201: z.object({
        name: z.string(),
        action: z.literal("created"),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Create or update a secret",
  },

  /**
   * DELETE /api/secrets?name={name}
   * Delete a secret by name
   */
  delete: {
    method: "DELETE",
    path: "/api/secrets",
    query: z.object({
      name: z.string().min(1, "Missing name query parameter"),
    }),
    responses: {
      200: z.object({
        name: z.string(),
        deleted: z.literal(true),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a secret",
  },
});

export type SecretsContract = typeof secretsContract;
