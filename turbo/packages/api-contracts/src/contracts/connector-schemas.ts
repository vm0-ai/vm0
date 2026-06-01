import { z } from "zod";

import { connectorTypeSchema } from "@vm0/connectors/connectors";

/**
 * Connector response schema
 */
export const connectorResponseSchema = z.object({
  id: z.uuid(),
  type: connectorTypeSchema,
  authMethod: z.string(),
  externalId: z.string().nullable(),
  externalUsername: z.string().nullable(),
  externalEmail: z.string().nullable(),
  oauthScopes: z.array(z.string()).nullable(),
  needsReconnect: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConnectorResponse = z.infer<typeof connectorResponseSchema>;

/**
 * List connectors response
 */
export const connectorListResponseSchema = z.object({
  connectors: z.array(connectorResponseSchema),
  configuredTypes: z.array(connectorTypeSchema),
  connectorProvidedEnvNames: z.array(z.string()),
});

export type ConnectorListResponse = z.infer<typeof connectorListResponseSchema>;

/**
 * Scope diff response schema
 */
export const scopeDiffResponseSchema = z.object({
  addedScopes: z.array(z.string()),
  removedScopes: z.array(z.string()),
  currentScopes: z.array(z.string()),
  storedScopes: z.array(z.string()),
});

export type ScopeDiffResponse = z.infer<typeof scopeDiffResponseSchema>;

export const connectorOauthStartResponseSchema = z.object({
  authorizationUrl: z.string(),
});

export type ConnectorOauthStartResponse = z.infer<
  typeof connectorOauthStartResponseSchema
>;

export const connectorOauthDeviceAuthSessionStartResponseSchema = z.object({
  sessionId: z.uuid(),
  sessionToken: z.string(),
  type: connectorTypeSchema,
  status: z.literal("pending"),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string().optional(),
  expiresIn: z.number(),
  interval: z.number(),
});

export type ConnectorOauthDeviceAuthSessionStartResponse = z.infer<
  typeof connectorOauthDeviceAuthSessionStartResponseSchema
>;

export const connectorOauthDeviceAuthSessionPollRequestSchema = z.object({
  sessionToken: z.string(),
});

export type ConnectorOauthDeviceAuthSessionPollRequest = z.infer<
  typeof connectorOauthDeviceAuthSessionPollRequestSchema
>;

export const connectorOauthDeviceAuthSessionPollResponseSchema =
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("pending"),
      interval: z.number(),
    }),
    z.object({
      status: z.literal("complete"),
      connector: connectorResponseSchema,
    }),
    z.object({
      status: z.literal("denied"),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
    z.object({
      status: z.literal("expired"),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
    z.object({
      status: z.literal("error"),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
  ]);

export type ConnectorOauthDeviceAuthSessionPollResponse = z.infer<
  typeof connectorOauthDeviceAuthSessionPollResponseSchema
>;
