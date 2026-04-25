import { z } from "zod";

import { connectorTypeSchema } from "./connectors";

/**
 * Connector response schema
 */
export const connectorResponseSchema = z.object({
  id: z.uuid().nullable(),
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
  connectorProvidedSecretNames: z.array(z.string()),
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

/**
 * Connector session status enum
 */
export const connectorSessionStatusSchema = z.enum([
  "pending",
  "complete",
  "expired",
  "error",
]);

export type ConnectorSessionStatus = z.infer<
  typeof connectorSessionStatusSchema
>;

/**
 * Connector session response schema
 */
export const connectorSessionResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  type: connectorTypeSchema,
  status: connectorSessionStatusSchema,
  verificationUrl: z.string(),
  expiresIn: z.number(),
  interval: z.number(),
  errorMessage: z.string().nullable().optional(),
});

export type ConnectorSessionResponse = z.infer<
  typeof connectorSessionResponseSchema
>;

/**
 * Connector session status response (for polling)
 */
export const connectorSessionStatusResponseSchema = z.object({
  status: connectorSessionStatusSchema,
  errorMessage: z.string().nullable().optional(),
});

export type ConnectorSessionStatusResponse = z.infer<
  typeof connectorSessionStatusResponseSchema
>;

/**
 * Computer connector create response
 */
export const computerConnectorCreateResponseSchema = z.object({
  id: z.uuid(),
  ngrokToken: z.string(),
  bridgeToken: z.string(),
  endpointPrefix: z.string(),
  domain: z.string(),
});

export type ComputerConnectorCreateResponse = z.infer<
  typeof computerConnectorCreateResponseSchema
>;
