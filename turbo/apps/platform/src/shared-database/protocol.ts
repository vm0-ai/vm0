import { z } from "zod";
import {
  chatThreadIndicatorsSchema,
  sharedDatabaseDataKeySchema,
  sharedDatabaseQuerySchema,
} from "./data-key.ts";

export const SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME =
  "SharedDatabaseClientNotConnectedError";
export const SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME =
  "SharedDatabaseAuthBlockedError";

export const sharedDatabaseHeartbeatResultSchema = z
  .object({ clientReconnected: z.boolean() })
  .strict();

export type SharedDatabaseHeartbeatResult = z.infer<
  typeof sharedDatabaseHeartbeatResultSchema
>;

const requestIdSchema = z.string().min(1);

const heartbeatRequestSchema = z
  .object({
    type: z.literal("heartbeat"),
    requestId: requestIdSchema,
    token: z.string().min(1),
    apiBaseUrl: z.string().url(),
    vercelProtectionBypass: z.string().min(1).optional(),
  })
  .strict();

const queryRequestSchema = z
  .object({
    type: z.literal("query"),
    requestId: requestIdSchema,
    query: sharedDatabaseQuerySchema,
  })
  .strict();

const indicatorsRequestSchema = z
  .object({
    type: z.literal("get-indicators"),
    requestId: requestIdSchema,
  })
  .strict();

const reloadIndicatorsRequestSchema = z
  .object({ type: z.literal("reload-indicators") })
  .strict();

const disconnectRequestSchema = z
  .object({ type: z.literal("disconnect") })
  .strict();

export const sharedDatabaseClientMessageSchema = z.discriminatedUnion("type", [
  heartbeatRequestSchema,
  queryRequestSchema,
  indicatorsRequestSchema,
  reloadIndicatorsRequestSchema,
  disconnectRequestSchema,
]);

export type SharedDatabaseClientMessage = z.infer<
  typeof sharedDatabaseClientMessageSchema
>;

const resultMessageSchema = z
  .object({
    type: z.literal("result"),
    requestId: requestIdSchema,
    value: z.unknown(),
  })
  .strict();

const errorMessageSchema = z
  .object({
    type: z.literal("error"),
    requestId: requestIdSchema,
    error: z
      .object({
        name: z.string(),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

const invalidateMessageSchema = z
  .object({
    type: z.literal("invalidate"),
    dataKey: sharedDatabaseDataKeySchema,
  })
  .strict();

const reconnectMessageSchema = z
  .object({ type: z.literal("reconnect") })
  .strict();

const reloadRequiredMessageSchema = z
  .object({ type: z.literal("reload-required") })
  .strict();

const authenticationRequiredMessageSchema = z
  .object({ type: z.literal("authentication-required") })
  .strict();

const indicatorsInvalidatedMessageSchema = z
  .object({
    type: z.literal("indicators-invalidated"),
    payload: z.unknown(),
  })
  .strict();

export const sharedDatabaseConnectionStatusSchema = z.enum([
  "connecting",
  "connected",
  "disconnected",
]);

export type SharedDatabaseConnectionStatus = z.infer<
  typeof sharedDatabaseConnectionStatusSchema
>;

const statusMessageSchema = z
  .object({
    type: z.literal("status"),
    status: sharedDatabaseConnectionStatusSchema,
  })
  .strict();

export const sharedDatabaseWorkerMessageSchema = z.discriminatedUnion("type", [
  resultMessageSchema,
  errorMessageSchema,
  invalidateMessageSchema,
  reconnectMessageSchema,
  reloadRequiredMessageSchema,
  authenticationRequiredMessageSchema,
  indicatorsInvalidatedMessageSchema,
  statusMessageSchema,
]);

export { chatThreadIndicatorsSchema };

export type SharedDatabaseWorkerMessage = z.infer<
  typeof sharedDatabaseWorkerMessageSchema
>;
