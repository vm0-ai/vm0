import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { ablyTokenRequestSchema } from "./realtime";

const c = initContract();

export const localBrowserHostStatusSchema = z.enum(["online", "offline"]);
export const localBrowserReadCommandKindSchema = z.enum([
  "tabs.list",
  "tabs.current",
  "page.snapshot",
  "page.screenshot",
  "page.selection",
  "page.metadata",
]);
export const localBrowserCommandStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export const localBrowserCommandErrorCodeSchema = z.enum([
  "no_active_tab",
  "permission_denied",
  "unsupported_page",
  "timeout",
  "unsupported_command",
]);

const hostNameSchema = z.string().trim().min(1).max(128);
const browserSchema = z.string().trim().min(1).max(64);
const extensionVersionSchema = z.string().trim().min(1).max(64);
const tabIdSchema = z.string().trim().min(1).max(128);
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

const localBrowserCommandCreateBodySchema = z.object({
  kind: localBrowserReadCommandKindSchema,
  tabId: tabIdSchema.optional(),
  hostId: z.string().min(1).optional(),
  hostName: hostNameSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
});

const localBrowserCommandPayloadSchema = z.object({
  tabId: tabIdSchema.optional(),
});

export const localBrowserTabSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  faviconUrl: z.string().optional(),
  active: z.boolean().optional(),
});

export const localBrowserCommandResultSchema = z.union([
  z.object({
    tabs: z.array(localBrowserTabSchema).max(100),
  }),
  z.object({
    tab: localBrowserTabSchema,
  }),
  z.object({
    snapshot: z.string().max(512_000),
    contentType: z.string().max(128).optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    imageBase64: z.string().max(2_000_000),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    text: z.string().max(64_000),
  }),
  z
    .object({
      title: z.string().max(512).optional(),
      url: z.string().max(2_048).optional(),
      faviconUrl: z.string().max(2_048).optional(),
    })
    .refine((value) => {
      return Object.keys(value).length > 0;
    }, "Metadata result must include at least one field"),
]);

export const localBrowserCommandErrorSchema = z.object({
  code: localBrowserCommandErrorCodeSchema,
  message: z.string().min(1).max(1_024),
});

export const localBrowserCommandCreateResponseSchema = z.object({
  commandId: z.string(),
  status: z.literal("queued"),
});

export const localBrowserCommandResponseSchema = z.object({
  id: z.string(),
  kind: localBrowserReadCommandKindSchema,
  status: localBrowserCommandStatusSchema,
  hostId: z.string().nullable(),
  hostName: z.string().nullable(),
  payload: localBrowserCommandPayloadSchema,
  result: localBrowserCommandResultSchema.optional(),
  error: localBrowserCommandErrorSchema.optional(),
  timeoutMs: z.number().int().positive().nullable(),
  createdAt: z.string(),
  claimedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const localBrowserHostCommandNextResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("idle") }),
    z.object({
      status: z.literal("command"),
      command: z.object({
        id: z.string(),
        kind: localBrowserReadCommandKindSchema,
        payload: localBrowserCommandPayloadSchema,
        timeoutMs: z.number().int().positive().nullable(),
      }),
    }),
  ],
);

const localBrowserHostCommandCompleteBodySchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("succeeded"),
      result: localBrowserCommandResultSchema,
    }),
    z.object({
      status: z.literal("failed"),
      error: localBrowserCommandErrorSchema,
    }),
  ],
);

export const localBrowserHostCommandCompleteResponseSchema = z.object({
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

export const zeroLocalBrowserCommandContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/local-browser/commands",
    headers: authHeadersSchema,
    body: localBrowserCommandCreateBodySchema,
    responses: {
      200: localBrowserCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a read-only local-browser command",
  },
  get: {
    method: "GET",
    path: "/api/zero/local-browser/commands/:commandId",
    pathParams: z.object({
      commandId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    responses: {
      200: localBrowserCommandResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a local-browser command result",
  },
});

export const zeroLocalBrowserHostCommandsContract = c.router({
  next: {
    method: "POST",
    path: "/api/zero/local-browser/host/commands/next",
    headers: authHeadersSchema,
    body: z.object({
      supportedCapabilities: supportedCapabilitiesSchema.default([]),
    }),
    responses: {
      200: localBrowserHostCommandNextResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Claim the next local-browser read command",
  },
  complete: {
    method: "POST",
    path: "/api/zero/local-browser/host/commands/:commandId/complete",
    pathParams: z.object({
      commandId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: localBrowserHostCommandCompleteBodySchema,
    responses: {
      200: localBrowserHostCommandCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Complete a local-browser read command",
  },
});

export type LocalBrowserHostStatus = z.infer<
  typeof localBrowserHostStatusSchema
>;
export type LocalBrowserReadCommandKind = z.infer<
  typeof localBrowserReadCommandKindSchema
>;
export type LocalBrowserCommandStatus = z.infer<
  typeof localBrowserCommandStatusSchema
>;
export type LocalBrowserCommandErrorCode = z.infer<
  typeof localBrowserCommandErrorCodeSchema
>;
export type LocalBrowserHost = z.infer<typeof localBrowserHostSchema>;
export type LocalBrowserTab = z.infer<typeof localBrowserTabSchema>;
export type LocalBrowserCommandResult = z.infer<
  typeof localBrowserCommandResultSchema
>;
export type LocalBrowserCommandError = z.infer<
  typeof localBrowserCommandErrorSchema
>;
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
export type LocalBrowserCommandCreateResponse = z.infer<
  typeof localBrowserCommandCreateResponseSchema
>;
export type LocalBrowserCommandResponse = z.infer<
  typeof localBrowserCommandResponseSchema
>;
export type LocalBrowserHostCommandNextResponse = z.infer<
  typeof localBrowserHostCommandNextResponseSchema
>;
export type LocalBrowserHostCommandCompleteResponse = z.infer<
  typeof localBrowserHostCommandCompleteResponseSchema
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
export type ZeroLocalBrowserCommandContract =
  typeof zeroLocalBrowserCommandContract;
export type ZeroLocalBrowserHostCommandsContract =
  typeof zeroLocalBrowserHostCommandsContract;
