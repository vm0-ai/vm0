import { z } from "zod";

import { connectorSlugSchema } from "./connector-identity";
import {
  connectorReconnectReasonSchema,
  connectorResponseConnectionStatusSchema,
} from "./connector-schemas";

export const connectorAccountDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255);

export const connectorAccountTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("builtin"),
      connectorSlug: connectorSlugSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      customConnectorId: z.uuid(),
    })
    .strict(),
]);

export const connectorAccountConnectionSchema = z
  .object({
    id: z.uuid(),
    target: connectorAccountTargetSchema,
    displayName: z.string().min(1).max(255).nullable(),
    isDefault: z.boolean(),
    externalId: z.string().nullable(),
    externalUsername: z.string().nullable(),
    externalEmail: z.string().nullable(),
    oauthScopes: z.array(z.string()).nullable(),
    connectionStatus: connectorResponseConnectionStatusSchema,
    reconnectReason: connectorReconnectReasonSchema.nullable(),
    tokenExpiresAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const connectorAccountSelectionSchema = z
  .object({
    connectionId: z.uuid(),
    target: connectorAccountTargetSchema,
  })
  .strict();

export const connectorAccountMutationIntentSchema = z.discriminatedUnion(
  "intent",
  [
    z
      .object({
        intent: z.literal("add"),
        displayName: connectorAccountDisplayNameSchema.optional(),
      })
      .strict(),
    z
      .object({
        intent: z.literal("reconnect"),
        connectionId: z.uuid(),
      })
      .strict(),
  ],
);

export type ConnectorAccountTarget = z.infer<
  typeof connectorAccountTargetSchema
>;
export type ConnectorAccountConnection = z.infer<
  typeof connectorAccountConnectionSchema
>;
export type ConnectorAccountSelection = z.infer<
  typeof connectorAccountSelectionSchema
>;
export type ConnectorAccountMutationIntent = z.infer<
  typeof connectorAccountMutationIntentSchema
>;
