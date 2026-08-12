import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * User preferences schemas (shared across contracts)
 */
export const sendModeSchema = z.enum(["enter", "cmd-enter"]);
export type SendMode = z.infer<typeof sendModeSchema>;

export const SUPPORTED_USER_LOCALES = [
  "en-US",
  "pt-BR",
  "ja-JP",
  "ko-KR",
  "id-ID",
  "de-DE",
  "es-ES",
  "it-IT",
  "fr-FR",
  "hi-IN",
] as const;
export const userLocaleSchema = z.enum(SUPPORTED_USER_LOCALES);
export type UserLocale = z.infer<typeof userLocaleSchema>;

export const userPreferencesResponseSchema = z.object({
  timezone: z.string().nullable(),
  locale: userLocaleSchema.nullable(),
  supportedLocales: z.array(userLocaleSchema),
  // Pinned agents are exposed as membership only. The API returns a stable
  // canonical order and ignores client-provided order on writes.
  pinnedAgentIds: z.array(z.string()),
  sendMode: sendModeSchema,
  morningBriefEnabled: z.boolean(),
  /**
   * Next scheduled Morning Brief send (ISO instant), or null when no run is
   * scheduled (preference off, timezone missing, or schedule not synced).
   */
  morningBriefNextRunAt: z.string().nullable(),
  captureNetworkBodiesRemaining: z.number().int().min(0),
});

export type UserPreferencesResponse = z.infer<
  typeof userPreferencesResponseSchema
>;

export const updateUserPreferencesRequestSchema = z
  .object({
    timezone: z.string().min(1).optional(),
    locale: userLocaleSchema.optional(),
    // Membership update only; request order is not used for display ordering.
    pinnedAgentIds: z.array(z.string()).optional(),
    sendMode: sendModeSchema.optional(),
    morningBriefEnabled: z.boolean().optional(),
    captureNetworkBodiesRemaining: z.number().int().min(0).optional(),
  })
  .refine(
    (data) => {
      return (
        data.timezone !== undefined ||
        data.locale !== undefined ||
        data.pinnedAgentIds !== undefined ||
        data.sendMode !== undefined ||
        data.morningBriefEnabled !== undefined ||
        data.captureNetworkBodiesRemaining !== undefined
      );
    },
    {
      message: "At least one preference must be provided",
    },
  );

export type UpdateUserPreferencesRequest = z.infer<
  typeof updateUserPreferencesRequestSchema
>;

/**
 * Zero user preferences contract for /api/okou/user-preferences
 *
 * GET: Get current user's preferences
 * POST: Update user preferences
 */
export const zeroUserPreferencesContract = c.router({
  get: {
    method: "GET",
    path: "/api/okou/user-preferences",
    headers: authHeadersSchema,
    responses: {
      200: userPreferencesResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get user preferences",
  },
  update: {
    method: "POST",
    path: "/api/okou/user-preferences",
    headers: authHeadersSchema,
    body: updateUserPreferencesRequestSchema,
    responses: {
      200: userPreferencesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update user preferences",
  },
});

export type ZeroUserPreferencesContract = typeof zeroUserPreferencesContract;
