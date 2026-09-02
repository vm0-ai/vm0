import { z } from "zod";
import { computedKeySchema } from "./computed-key.ts";
import {
  sharedDatabaseDataKeySchema,
  sharedDatabaseQuerySchema,
} from "./data-key.ts";

export const SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME =
  "SharedDatabaseClientNotConnectedError";

const requestIdSchema = z.string().min(1);

const registerTabMessageSchema = z
  .object({
    type: z.literal("register-tab"),
    // Only a page can read the dev browser JWT a development Clerk instance
    // needs, so the tab passes it along when it registers.
    devBrowserJwt: z.string().min(1).optional(),
  })
  .strict();

const queryRequestSchema = z
  .object({
    type: z.literal("query"),
    requestId: requestIdSchema,
    query: sharedDatabaseQuerySchema,
  })
  .strict();

const getComputedRequestSchema = z
  .object({
    type: z.literal("get-computed"),
    requestId: requestIdSchema,
    computedKey: computedKeySchema,
  })
  .strict();

const reloadComputedMessageSchema = z
  .object({
    type: z.literal("reload-computed"),
    computedKey: computedKeySchema,
  })
  .strict();

const disconnectRequestSchema = z
  .object({ type: z.literal("disconnect") })
  .strict();

export const sharedDatabaseClientMessageSchema = z.discriminatedUnion("type", [
  registerTabMessageSchema,
  queryRequestSchema,
  getComputedRequestSchema,
  reloadComputedMessageSchema,
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

const chatThreadReadCursorUpdatedMessageSchema = z
  .object({
    type: z.literal("chat-thread-read-cursor-updated"),
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
  reloadComputedMessageSchema,
  chatThreadReadCursorUpdatedMessageSchema,
  statusMessageSchema,
]);

export type SharedDatabaseWorkerMessage = z.infer<
  typeof sharedDatabaseWorkerMessageSchema
>;
