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
export const localBrowserWriteCommandKindSchema = z.enum([
  "page.click",
  "page.type",
  "page.scroll",
  "page.navigate",
  "tabs.activate",
  "tabs.open",
  "tabs.close",
]);
export const localBrowserCommandKindSchema = z.enum([
  ...localBrowserReadCommandKindSchema.options,
  ...localBrowserWriteCommandKindSchema.options,
]);
export const localBrowserCommandStatusSchema = z.enum([
  "pending_approval",
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
const targetUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use http or https");
const cssSelectorSchema = z.string().trim().min(1).max(1_024);
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

export const localBrowserAuditEventSchema = z.object({
  id: z.string(),
  commandId: z.string(),
  runId: z.string().nullable(),
  hostId: z.string().nullable(),
  tabId: z.string().nullable(),
  kind: localBrowserWriteCommandKindSchema,
  targetUrl: z.string().nullable(),
  event: z.enum(["created", "approved", "denied", "completed"]),
  approvalOutcome: z.enum(["approved", "denied"]).nullable(),
  redactedResult: z.record(z.string(), z.unknown()).nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export const localBrowserAuditEventListResponseSchema = z.object({
  auditEvents: z.array(localBrowserAuditEventSchema),
});

export const localBrowserHostStartResponseSchema = z.object({
  hostId: z.string(),
  hostToken: z.string(),
});

export const localBrowserHostDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

const localBrowserCommandTargetShape = {
  tabId: tabIdSchema.optional(),
  hostId: z.string().min(1).optional(),
  hostName: hostNameSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
} as const;

const localBrowserCommandCreateBodySchema = z.object({
  kind: localBrowserReadCommandKindSchema,
  ...localBrowserCommandTargetShape,
});

const localBrowserWriteCommandCreateBodySchema = z
  .object({
    kind: localBrowserWriteCommandKindSchema,
    ...localBrowserCommandTargetShape,
    selector: cssSelectorSchema.optional(),
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    text: z.string().min(1).max(64_000).optional(),
    direction: z.enum(["up", "down"]).optional(),
    amount: z.number().int().positive().max(10_000).optional(),
    url: targetUrlSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const requireField = (field: string, message: string) => {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message,
      });
    };

    if (body.kind === "page.click") {
      const hasPoint = body.x !== undefined && body.y !== undefined;
      if (!body.selector && !hasPoint) {
        requireField("selector", "page.click requires selector or x/y");
      }
      if ((body.x === undefined) !== (body.y === undefined)) {
        requireField("x", "page.click coordinates require both x and y");
      }
      return;
    }

    if (body.kind === "page.type") {
      if (!body.selector) {
        requireField("selector", "page.type requires selector");
      }
      if (!body.text) {
        requireField("text", "page.type requires text");
      }
      return;
    }

    if (body.kind === "page.scroll") {
      if (!body.direction) {
        requireField("direction", "page.scroll requires direction");
      }
      if (!body.amount) {
        requireField("amount", "page.scroll requires amount");
      }
      return;
    }

    if (body.kind === "page.navigate" || body.kind === "tabs.open") {
      if (!body.url) {
        requireField("url", `${body.kind} requires url`);
      }
      return;
    }

    if (
      (body.kind === "tabs.activate" || body.kind === "tabs.close") &&
      !body.tabId
    ) {
      requireField("tabId", `${body.kind} requires tabId`);
    }
  });

const localBrowserCommandPayloadSchema = z.object({
  tabId: tabIdSchema.optional(),
  selector: cssSelectorSchema.optional(),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  text: z.string().max(64_000).optional(),
  direction: z.enum(["up", "down"]).optional(),
  amount: z.number().int().positive().max(10_000).optional(),
  url: targetUrlSchema.optional(),
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
  z.object({
    ok: z.literal(true),
    details: z.string().max(1_024).optional(),
  }),
]);

export const localBrowserCommandErrorSchema = z.object({
  code: localBrowserCommandErrorCodeSchema,
  message: z.string().min(1).max(1_024),
});

export const localBrowserCommandCreateResponseSchema = z.object({
  commandId: z.string(),
  status: z.enum(["queued", "pending_approval"]),
});

export const localBrowserCommandResponseSchema = z.object({
  id: z.string(),
  kind: localBrowserCommandKindSchema,
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
        kind: localBrowserCommandKindSchema,
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

export const localBrowserCommandApprovalResponseSchema = z.object({
  commandId: z.string(),
  status: z.enum(["queued", "failed"]),
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

export const zeroLocalBrowserAuditEventsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/local-browser/audit-events",
    headers: authHeadersSchema,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      commandId: z.string().min(1).optional(),
      hostId: z.string().min(1).optional(),
      runId: z.string().min(1).optional(),
    }),
    responses: {
      200: localBrowserAuditEventListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List local-browser write command audit events",
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

export const zeroLocalBrowserWriteCommandContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/local-browser/write-commands",
    headers: authHeadersSchema,
    body: localBrowserWriteCommandCreateBodySchema,
    responses: {
      200: localBrowserCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create an approved-write local-browser command",
  },
});

export const zeroLocalBrowserCommandApprovalContract = c.router({
  decide: {
    method: "POST",
    path: "/api/zero/local-browser/commands/:commandId/approval",
    pathParams: z.object({
      commandId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: z.object({
      decision: z.enum(["approve", "deny"]),
      message: z.string().trim().min(1).max(1_024).optional(),
    }),
    responses: {
      200: localBrowserCommandApprovalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Approve or deny a pending local-browser write command",
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
    summary: "Claim the next approved local-browser command",
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
    summary: "Complete a local-browser command",
  },
});

export type LocalBrowserHostStatus = z.infer<
  typeof localBrowserHostStatusSchema
>;
export type LocalBrowserReadCommandKind = z.infer<
  typeof localBrowserReadCommandKindSchema
>;
export type LocalBrowserWriteCommandKind = z.infer<
  typeof localBrowserWriteCommandKindSchema
>;
export type LocalBrowserCommandKind = z.infer<
  typeof localBrowserCommandKindSchema
>;
export type LocalBrowserCommandStatus = z.infer<
  typeof localBrowserCommandStatusSchema
>;
export type LocalBrowserCommandErrorCode = z.infer<
  typeof localBrowserCommandErrorCodeSchema
>;
export type LocalBrowserHost = z.infer<typeof localBrowserHostSchema>;
export type LocalBrowserAuditEvent = z.infer<
  typeof localBrowserAuditEventSchema
>;
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
export type LocalBrowserAuditEventListResponse = z.infer<
  typeof localBrowserAuditEventListResponseSchema
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
export type LocalBrowserCommandApprovalResponse = z.infer<
  typeof localBrowserCommandApprovalResponseSchema
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
export type ZeroLocalBrowserAuditEventsContract =
  typeof zeroLocalBrowserAuditEventsContract;
export type ZeroLocalBrowserHostSelfContract =
  typeof zeroLocalBrowserHostSelfContract;
export type ZeroLocalBrowserCommandContract =
  typeof zeroLocalBrowserCommandContract;
export type ZeroLocalBrowserWriteCommandContract =
  typeof zeroLocalBrowserWriteCommandContract;
export type ZeroLocalBrowserCommandApprovalContract =
  typeof zeroLocalBrowserCommandApprovalContract;
export type ZeroLocalBrowserHostCommandsContract =
  typeof zeroLocalBrowserHostCommandsContract;
