import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { modelProviderResponseSchema } from "./model-providers";

const c = initContract();

export const codexDeviceAuthScopeSchema = z.enum(["org", "personal"]);

const codexDeviceAuthStartResponseSchema = z.object({
  sessionToken: z.string(),
  type: z.literal("codex"),
  status: z.literal("pending"),
  scope: codexDeviceAuthScopeSchema,
  browserUrl: z.url(),
  verificationCode: z.string().min(1),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});

const codexDeviceAuthCompleteResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    errorMessage: z.string().nullable(),
  }),
  z.object({
    status: z.literal("complete"),
    provider: modelProviderResponseSchema,
    created: z.boolean(),
  }),
]);

/**
 * Zero contract for Codex device auth.
 * Runs the official `codex login --device-auth` flow in a managed sandbox and
 * imports the resulting auth.json through the existing Codex auth_json parser.
 */
export const zeroCodexDeviceAuthContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/model-providers/codex/device-auth/sessions",
    headers: authHeadersSchema,
    body: z.object({ scope: codexDeviceAuthScopeSchema }),
    responses: {
      200: codexDeviceAuthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start Codex device auth in a sandbox",
  },
  complete: {
    method: "POST",
    path: "/api/zero/model-providers/codex/device-auth/sessions/complete",
    headers: authHeadersSchema,
    body: z.object({ sessionToken: z.string().min(1) }),
    responses: {
      200: codexDeviceAuthCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Complete Codex device auth and import ChatGPT credentials",
  },
});

export type CodexDeviceAuthScope = z.infer<typeof codexDeviceAuthScopeSchema>;
export type ZeroCodexDeviceAuthContract = typeof zeroCodexDeviceAuthContract;
