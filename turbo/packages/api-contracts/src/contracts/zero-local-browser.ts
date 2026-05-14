import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { ablyTokenRequestSchema } from "./realtime";

const c = initContract();

export const localBrowserHostStatusSchema = z.enum(["online", "offline"]);

const hostNameSchema = z.string().trim().min(1).max(128);
const browserSchema = z.string().trim().min(1).max(64);
const extensionVersionSchema = z.string().trim().min(1).max(64);
const supportedCapabilitiesSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(50);

const localBrowserRuntimeBodySchema = z.object({
  hostName: hostNameSchema,
  browser: browserSchema,
  extensionVersion: extensionVersionSchema,
  supportedCapabilities: supportedCapabilitiesSchema.default([]),
});

const localBrowserRealtimeSubscriptionSchema = z.object({
  channelName: z.string(),
  eventName: z.string(),
  tokenRequest: ablyTokenRequestSchema,
});

export const localBrowserDeviceStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationPath: z.string(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
  pollToken: z.string(),
  realtime: localBrowserRealtimeSubscriptionSchema.optional(),
});

export const localBrowserDevicePollResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("pending") }),
    z.object({
      status: z.literal("linked"),
      hostId: z.string(),
      hostToken: z.string().optional(),
    }),
    z.object({ status: z.literal("expired") }),
  ],
);

export const localBrowserDeviceClaimResponseSchema = z.object({
  status: z.literal("approved"),
});

export const localBrowserHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  hostId: z.string(),
});

export const localBrowserHostSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  browser: z.string(),
  extensionVersion: z.string(),
  supportedCapabilities: z.array(z.string()),
  status: localBrowserHostStatusSchema,
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const localBrowserHostListResponseSchema = z.object({
  hosts: z.array(localBrowserHostSchema),
});

export const localBrowserHostStartResponseSchema = z.object({
  hostId: z.string(),
  hostToken: z.string(),
});

export const localBrowserHostDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const zeroLocalBrowserDeviceStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/local-browser/device/start",
    body: localBrowserRuntimeBodySchema,
    responses: {
      200: localBrowserDeviceStartResponseSchema,
      400: apiErrorSchema,
    },
    summary: "Start a local-browser device pairing flow",
  },
});

export const zeroLocalBrowserDevicePollContract = c.router({
  poll: {
    method: "POST",
    path: "/api/zero/local-browser/device/poll",
    body: z.object({
      deviceCode: z.string().min(1),
      pollToken: z.string().min(1),
    }),
    responses: {
      200: localBrowserDevicePollResponseSchema,
      400: apiErrorSchema,
    },
    summary: "Poll a local-browser device pairing flow",
  },
});

export const zeroLocalBrowserDeviceClaimContract = c.router({
  claim: {
    method: "POST",
    path: "/api/zero/local-browser/device/claim",
    headers: authHeadersSchema,
    body: z.object({
      deviceCode: z.string().min(1),
    }),
    responses: {
      200: localBrowserDeviceClaimResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Approve a local-browser device pairing flow",
  },
});

export const zeroLocalBrowserHeartbeatContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/api/zero/local-browser/heartbeat",
    headers: authHeadersSchema,
    body: localBrowserRuntimeBodySchema,
    responses: {
      200: localBrowserHeartbeatResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Refresh a linked local-browser host heartbeat",
  },
});

export const zeroLocalBrowserHostRealtimeContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/local-browser/host/realtime-token",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: localBrowserRealtimeSubscriptionSchema,
      401: apiErrorSchema,
    },
    summary: "Get Ably token for local-browser command wakeups",
  },
});

export const zeroLocalBrowserHostsContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/local-browser/hosts/start",
    headers: authHeadersSchema,
    body: localBrowserRuntimeBodySchema.extend({
      hostId: z.string().min(1).optional(),
    }),
    responses: {
      200: localBrowserHostStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Start or reactivate a local-browser host",
  },
  list: {
    method: "GET",
    path: "/api/zero/local-browser/hosts",
    headers: authHeadersSchema,
    responses: {
      200: localBrowserHostListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List linked local-browser hosts",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/local-browser/hosts/:hostId",
    pathParams: z.object({
      hostId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: localBrowserHostDeleteResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a local-browser host",
  },
});

export const zeroLocalBrowserHostSelfContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/local-browser/host",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: localBrowserHostDeleteResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Revoke the current local-browser host token",
  },
});

export type LocalBrowserHostStatus = z.infer<
  typeof localBrowserHostStatusSchema
>;
export type LocalBrowserHost = z.infer<typeof localBrowserHostSchema>;
export type LocalBrowserDeviceStartResponse = z.infer<
  typeof localBrowserDeviceStartResponseSchema
>;
export type LocalBrowserDevicePollResponse = z.infer<
  typeof localBrowserDevicePollResponseSchema
>;
export type LocalBrowserRealtimeSubscription = z.infer<
  typeof localBrowserRealtimeSubscriptionSchema
>;
export type LocalBrowserHostListResponse = z.infer<
  typeof localBrowserHostListResponseSchema
>;
export type LocalBrowserHostStartResponse = z.infer<
  typeof localBrowserHostStartResponseSchema
>;
export type LocalBrowserHostDeleteResponse = z.infer<
  typeof localBrowserHostDeleteResponseSchema
>;
export type ZeroLocalBrowserDeviceStartContract =
  typeof zeroLocalBrowserDeviceStartContract;
export type ZeroLocalBrowserDevicePollContract =
  typeof zeroLocalBrowserDevicePollContract;
export type ZeroLocalBrowserDeviceClaimContract =
  typeof zeroLocalBrowserDeviceClaimContract;
export type ZeroLocalBrowserHeartbeatContract =
  typeof zeroLocalBrowserHeartbeatContract;
export type ZeroLocalBrowserHostRealtimeContract =
  typeof zeroLocalBrowserHostRealtimeContract;
export type ZeroLocalBrowserHostsContract =
  typeof zeroLocalBrowserHostsContract;
export type ZeroLocalBrowserHostSelfContract =
  typeof zeroLocalBrowserHostSelfContract;
