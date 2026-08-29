import { z } from "zod";
import {
  sharedDatabaseDataKeySchema,
  sharedDatabaseIdentitySchema,
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
const subscriptionIdSchema = z.string().min(1);

const heartbeatRequestSchema = z
  .object({
    type: z.literal("heartbeat"),
    requestId: requestIdSchema,
    identity: sharedDatabaseIdentitySchema,
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

const subscribeRequestSchema = z
  .object({
    type: z.literal("subscribe"),
    requestId: requestIdSchema,
    subscriptionId: subscriptionIdSchema,
    dataKey: sharedDatabaseDataKeySchema,
  })
  .strict();

const unsubscribeRequestSchema = z
  .object({
    type: z.literal("unsubscribe"),
    subscriptionId: subscriptionIdSchema,
  })
  .strict();

const cancelRequestSchema = z
  .object({
    type: z.literal("cancel"),
    requestId: requestIdSchema,
  })
  .strict();

const disconnectRequestSchema = z
  .object({ type: z.literal("disconnect") })
  .strict();

export const sharedDatabaseClientMessageSchema = z.discriminatedUnion("type", [
  heartbeatRequestSchema,
  queryRequestSchema,
  subscribeRequestSchema,
  unsubscribeRequestSchema,
  cancelRequestSchema,
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

const appendMessageSchema = z
  .object({
    type: z.literal("append"),
    subscriptionId: subscriptionIdSchema,
    dataKey: sharedDatabaseDataKeySchema,
  })
  .strict();

const reloadRequiredMessageSchema = z
  .object({ type: z.literal("reload-required") })
  .strict();

const authenticationRequiredMessageSchema = z
  .object({ type: z.literal("authentication-required") })
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
  appendMessageSchema,
  reloadRequiredMessageSchema,
  authenticationRequiredMessageSchema,
  statusMessageSchema,
]);

export type SharedDatabaseWorkerMessage = z.infer<
  typeof sharedDatabaseWorkerMessageSchema
>;
