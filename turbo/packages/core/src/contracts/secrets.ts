import { z } from "zod";

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
export const secretTypeSchema = z.enum(["user", "model-provider", "connector"]);

export type SecretType = z.infer<typeof secretTypeSchema>;

/**
 * Secret metadata response (value is never returned)
 */
export const secretResponseSchema = z.object({
  id: z.uuid(),
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
