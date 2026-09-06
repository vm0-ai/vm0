import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const SSH_CONNECTION_LIMIT = 64;
export const SSH_DISPLAY_NAME_MAX_LENGTH = 128;
export const SSH_HOST_MAX_LENGTH = 253;
export const SSH_USERNAME_MAX_LENGTH = 255;
export const SSH_PRIVATE_KEY_MAX_LENGTH = 65_536;
export const SSH_PASSPHRASE_MAX_LENGTH = 4_096;

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SSH_DISPLAY_NAME_MAX_LENGTH);
const hostSchema = z.string().trim().min(1).max(SSH_HOST_MAX_LENGTH);
const portSchema = z.int().min(1).max(65_535);
const usernameSchema = z.string().trim().min(1).max(SSH_USERNAME_MAX_LENGTH);
const privateKeySchema = z.string().min(1).max(SSH_PRIVATE_KEY_MAX_LENGTH);
const passphraseSchema = z
  .string()
  .min(1)
  .max(SSH_PASSPHRASE_MAX_LENGTH)
  .nullable();

export const sshConnectionCredentialsInputSchema = z
  .object({
    privateKey: privateKeySchema,
    passphrase: passphraseSchema.default(null),
  })
  .strict();

export const createSshConnectionRequestSchema = z
  .object({
    displayName: displayNameSchema,
    host: hostSchema,
    port: portSchema.default(22),
    username: usernameSchema,
    privateKey: privateKeySchema,
    passphrase: passphraseSchema.default(null),
  })
  .strict();

export const updateSshConnectionRequestSchema = z
  .object({
    expectedGeneration: z.int().positive(),
    displayName: displayNameSchema.optional(),
    host: hostSchema.optional(),
    port: portSchema.optional(),
    username: usernameSchema.optional(),
    credentials: sshConnectionCredentialsInputSchema.optional(),
  })
  .strict()
  .refine(
    (body) => {
      return (
        body.displayName !== undefined ||
        body.host !== undefined ||
        body.port !== undefined ||
        body.username !== undefined ||
        body.credentials !== undefined
      );
    },
    { message: "At least one SSH connection field must be updated" },
  );

export const resetSshConnectionHostKeyRequestSchema = z
  .object({ expectedGeneration: z.int().positive() })
  .strict();

export const sshConnectionPathParamsSchema = z
  .object({ connectionId: z.uuid() })
  .strict();

export const sshConnectionResponseSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    host: z.string(),
    port: z.int(),
    username: z.string(),
    generation: z.int().positive(),
    learnedHostKey: z
      .object({
        algorithm: z.string(),
        fingerprint: z.string(),
      })
      .strict()
      .nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const sshConnectionsListResponseSchema = z
  .object({ connections: z.array(sshConnectionResponseSchema) })
  .strict();

export const sshConnectionsSummaryResponseSchema = z
  .object({
    configuredCount: z.int().nonnegative(),
    limit: z.literal(SSH_CONNECTION_LIMIT),
  })
  .strict();

export const sshConnectionsContract = c.router({
  list: {
    method: "GET",
    path: "/api/ssh/connections",
    headers: authHeadersSchema,
    responses: {
      200: sshConnectionsListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List SSH connections",
  },
  summary: {
    method: "GET",
    path: "/api/ssh/connections/summary",
    headers: authHeadersSchema,
    responses: {
      200: sshConnectionsSummaryResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Summarize SSH connection configuration",
  },
  create: {
    method: "POST",
    path: "/api/ssh/connections",
    headers: authHeadersSchema,
    body: createSshConnectionRequestSchema,
    responses: {
      201: sshConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create an SSH connection",
  },
  update: {
    method: "PATCH",
    path: "/api/ssh/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: sshConnectionPathParamsSchema,
    body: updateSshConnectionRequestSchema,
    responses: {
      200: sshConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update an SSH connection",
  },
  delete: {
    method: "DELETE",
    path: "/api/ssh/connections/:connectionId",
    headers: authHeadersSchema,
    pathParams: sshConnectionPathParamsSchema,
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an SSH connection",
  },
  resetHostKey: {
    method: "POST",
    path: "/api/ssh/connections/:connectionId/reset-host-key",
    headers: authHeadersSchema,
    pathParams: sshConnectionPathParamsSchema,
    body: resetSshConnectionHostKeyRequestSchema,
    responses: {
      200: sshConnectionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Reset a learned SSH host key",
  },
});

export type CreateSshConnectionRequest = z.infer<
  typeof createSshConnectionRequestSchema
>;
export type UpdateSshConnectionRequest = z.infer<
  typeof updateSshConnectionRequestSchema
>;
export type SshConnectionResponse = z.infer<typeof sshConnectionResponseSchema>;
export type SshConnectionsContract = typeof sshConnectionsContract;
