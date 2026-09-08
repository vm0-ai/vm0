import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";
import {
  SSH_HOST_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
} from "./ssh-connections";

const c = initContract();
const generationSchema = z.int().positive().max(2_147_483_647);

export const sshHostKeySchema = z
  .object({
    // RSA key identity is ssh-rsa; the Runner must use SHA-2 signatures.
    algorithm: z.enum([
      "ssh-ed25519",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "ssh-rsa",
    ]),
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/u),
  })
  .strict();

const resolveRequestSchema = z
  .object({
    connectionId: z.uuid(),
    runnerIdentity: z
      .object({
        runnerId: z.uuid(),
        heartbeatGeneration: runnerHeartbeatGenerationSchema,
      })
      .strict(),
  })
  .strict();

const unavailableSchema = z
  .object({ outcome: z.literal("unavailable") })
  .strict();
const resolveResponseSchema = z.discriminatedUnion("outcome", [
  unavailableSchema,
  z
    .object({
      outcome: z.literal("resolved"),
      host: z.string().min(1).max(SSH_HOST_MAX_LENGTH),
      port: z.int().min(1).max(65_535),
      username: z.string().min(1).max(SSH_USERNAME_MAX_LENGTH),
      generation: generationSchema,
      learnedHostKey: sshHostKeySchema.nullable(),
      privateKey: z.string().min(1).max(SSH_PRIVATE_KEY_MAX_LENGTH),
      passphrase: z.string().min(1).max(SSH_PASSPHRASE_MAX_LENGTH).nullable(),
    })
    .strict(),
]);

const pinRequestSchema = resolveRequestSchema
  .extend({
    expectedGeneration: generationSchema,
    observedHostKey: sshHostKeySchema,
  })
  .strict();

const pinResponseSchema = z.discriminatedUnion("outcome", [
  unavailableSchema,
  z
    .object({ outcome: z.literal("pinned"), generation: generationSchema })
    .strict(),
  z
    .object({ outcome: z.literal("matched"), generation: generationSchema })
    .strict(),
  z.object({ outcome: z.literal("host_key_mismatch") }).strict(),
  z.object({ outcome: z.literal("configuration_changed") }).strict(),
]);

export const runnerSshContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/resolve",
    pathParams: z.object({ runId: z.uuid() }).strict(),
    headers: authHeadersSchema,
    body: resolveRequestSchema,
    responses: {
      200: resolveResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Resolve one current SSH credential for the winning official Runner",
  },
  pin: {
    method: "POST",
    path: "/api/runners/runs/:runId/ssh/pin",
    pathParams: z.object({ runId: z.uuid() }).strict(),
    headers: authHeadersSchema,
    body: pinRequestSchema,
    responses: {
      200: pinResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Atomically learn an SSH host key under current Run authority",
  },
});

export type RunnerSshResolveRequest = z.infer<typeof resolveRequestSchema>;
export type RunnerSshResolveResponse = z.infer<typeof resolveResponseSchema>;
export type RunnerSshPinRequest = z.infer<typeof pinRequestSchema>;
export type RunnerSshPinResponse = z.infer<typeof pinResponseSchema>;
