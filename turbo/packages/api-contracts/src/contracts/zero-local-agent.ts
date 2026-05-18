import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { ablyTokenRequestSchema } from "./realtime";

const c = initContract();

export const localAgentBackendSchema = z.enum(["codex", "claude-code"]);
export const localAgentJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export const localAgentHostStatusSchema = z.enum(["online", "closed"]);

const hostNameSchema = z.string().trim().min(1).max(128);
const supportedBackendsSchema = z.array(localAgentBackendSchema).min(1).max(2);
const promptSchema = z.string().trim().min(1).max(60_000);

const localAgentRealtimeSubscriptionSchema = z.object({
  channelName: z.string(),
  eventName: z.string(),
  tokenRequest: ablyTokenRequestSchema,
});

export const localAgentDeviceStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationPath: z.string(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
  pollToken: z.string(),
  realtime: localAgentRealtimeSubscriptionSchema.optional(),
});

export const localAgentDevicePollResponseSchema = z.discriminatedUnion(
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

export const localAgentDeviceClaimResponseSchema = z.object({
  status: z.literal("approved"),
});

export const localAgentHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  hostId: z.string(),
});

export const localAgentRunCreateResponseSchema = z.object({
  jobId: z.string(),
  status: localAgentJobStatusSchema,
});

export const localAgentRunResponseSchema = z.object({
  id: z.string(),
  hostId: z.string().nullable(),
  backend: localAgentBackendSchema.nullable(),
  prompt: z.string(),
  status: localAgentJobStatusSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const localAgentRunListItemSchema = localAgentRunResponseSchema
  .omit({ output: true, error: true })
  .extend({
    hostName: z.string().nullable(),
  });

export const localAgentRunListResponseSchema = z.object({
  runs: z.array(localAgentRunListItemSchema),
});

export const localAgentHostJobNextResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("idle") }),
    z.object({
      status: z.literal("job"),
      job: z.object({
        id: z.string(),
        backend: localAgentBackendSchema,
        prompt: z.string(),
      }),
    }),
  ],
);

export const localAgentHostJobCompleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const localAgentHostSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  supportedBackends: z.array(localAgentBackendSchema),
  status: localAgentHostStatusSchema,
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const localAgentHostListResponseSchema = z.object({
  hosts: z.array(localAgentHostSchema),
});

export const localAgentHostStartResponseSchema = z.object({
  hostId: z.string(),
  hostToken: z.string(),
});

export const localAgentHostDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const localAgentHostCloseResponseSchema = z.object({
  ok: z.literal(true),
});

export const zeroLocalAgentDeviceStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/local-agent/device/start",
    body: z.object({
      hostName: hostNameSchema,
      supportedBackends: supportedBackendsSchema,
    }),
    responses: {
      200: localAgentDeviceStartResponseSchema,
      400: apiErrorSchema,
    },
    summary: "Start a local-agent device pairing flow",
  },
});

export const zeroLocalAgentDevicePollContract = c.router({
  poll: {
    method: "POST",
    path: "/api/zero/local-agent/device/poll",
    body: z.object({
      deviceCode: z.string().min(1),
      pollToken: z.string().min(1),
    }),
    responses: {
      200: localAgentDevicePollResponseSchema,
      400: apiErrorSchema,
    },
    summary: "Poll a local-agent device pairing flow",
  },
});

export const zeroLocalAgentDeviceClaimContract = c.router({
  claim: {
    method: "POST",
    path: "/api/zero/local-agent/device/claim",
    headers: authHeadersSchema,
    body: z.object({
      deviceCode: z.string().min(1),
    }),
    responses: {
      200: localAgentDeviceClaimResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Approve a local-agent device pairing flow",
  },
});

export const zeroLocalAgentHeartbeatContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/api/zero/local-agent/heartbeat",
    headers: authHeadersSchema,
    body: z.object({
      hostName: hostNameSchema,
      supportedBackends: supportedBackendsSchema,
      realtimeConnected: z.boolean().optional(),
    }),
    responses: {
      200: localAgentHeartbeatResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Refresh a linked local-agent host heartbeat",
  },
});

export const zeroLocalAgentHostRealtimeContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/local-agent/host/realtime-token",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: localAgentRealtimeSubscriptionSchema,
      401: apiErrorSchema,
    },
    summary: "Get Ably token for local-agent host job notifications",
  },
});

export const zeroLocalAgentRunContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/local-agent/runs",
    headers: authHeadersSchema,
    query: z.object({
      status: localAgentJobStatusSchema.optional(),
      hostId: z.string().min(1).optional(),
      hostName: z.string().trim().min(1).max(128).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    responses: {
      200: localAgentRunListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List local-agent jobs",
  },
  create: {
    method: "POST",
    path: "/api/zero/local-agent/run",
    headers: authHeadersSchema,
    body: z.object({
      prompt: promptSchema,
      hostName: z.string().trim().min(1).max(128).optional(),
    }),
    responses: {
      200: localAgentRunCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a local-agent job",
  },
  get: {
    method: "GET",
    path: "/api/zero/local-agent/run/:jobId",
    pathParams: z.object({
      jobId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    responses: {
      200: localAgentRunResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a local-agent job",
  },
});

export const zeroLocalAgentHostsContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/local-agent/hosts/start",
    headers: authHeadersSchema,
    body: z.object({
      hostName: hostNameSchema,
      supportedBackends: supportedBackendsSchema,
      hostId: z.string().min(1).optional(),
    }),
    responses: {
      200: localAgentHostStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Start or reactivate a local-agent host",
  },
  list: {
    method: "GET",
    path: "/api/zero/local-agent/hosts",
    headers: authHeadersSchema,
    responses: {
      200: localAgentHostListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List linked local-agent hosts",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/local-agent/hosts/:hostId",
    pathParams: z.object({
      hostId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: localAgentHostDeleteResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a local-agent host",
  },
  close: {
    method: "POST",
    path: "/api/zero/local-agent/hosts/close",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: localAgentHostCloseResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Mark the current local-agent host closed",
  },
});

export const zeroLocalAgentHostJobsContract = c.router({
  next: {
    method: "POST",
    path: "/api/zero/local-agent/host/jobs/next",
    headers: authHeadersSchema,
    body: z.object({
      supportedBackends: supportedBackendsSchema,
    }),
    responses: {
      200: localAgentHostJobNextResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Claim the next local-agent host job",
  },
  complete: {
    method: "POST",
    path: "/api/zero/local-agent/host/jobs/:jobId/complete",
    pathParams: z.object({
      jobId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: z.object({
      status: z.enum(["succeeded", "failed"]),
      output: z.string().optional(),
      error: z.string().optional(),
      exitCode: z.number().int().optional(),
    }),
    responses: {
      200: localAgentHostJobCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Complete a local-agent host job",
  },
});

export type LocalAgentBackend = z.infer<typeof localAgentBackendSchema>;
export type LocalAgentJobStatus = z.infer<typeof localAgentJobStatusSchema>;
export type LocalAgentHostStatus = z.infer<typeof localAgentHostStatusSchema>;
export type LocalAgentHost = z.infer<typeof localAgentHostSchema>;
export type LocalAgentDeviceStartResponse = z.infer<
  typeof localAgentDeviceStartResponseSchema
>;
export type LocalAgentRealtimeSubscription = z.infer<
  typeof localAgentRealtimeSubscriptionSchema
>;
export type LocalAgentDevicePollResponse = z.infer<
  typeof localAgentDevicePollResponseSchema
>;
export type LocalAgentRunCreateResponse = z.infer<
  typeof localAgentRunCreateResponseSchema
>;
export type LocalAgentRunResponse = z.infer<typeof localAgentRunResponseSchema>;
export type LocalAgentRunListItem = z.infer<typeof localAgentRunListItemSchema>;
export type LocalAgentRunListResponse = z.infer<
  typeof localAgentRunListResponseSchema
>;
export type LocalAgentHostListResponse = z.infer<
  typeof localAgentHostListResponseSchema
>;
export type LocalAgentHostStartResponse = z.infer<
  typeof localAgentHostStartResponseSchema
>;
export type LocalAgentHostDeleteResponse = z.infer<
  typeof localAgentHostDeleteResponseSchema
>;
export type LocalAgentHostCloseResponse = z.infer<
  typeof localAgentHostCloseResponseSchema
>;
export type LocalAgentHostJobNextResponse = z.infer<
  typeof localAgentHostJobNextResponseSchema
>;
export type ZeroLocalAgentDeviceStartContract =
  typeof zeroLocalAgentDeviceStartContract;
export type ZeroLocalAgentDevicePollContract =
  typeof zeroLocalAgentDevicePollContract;
export type ZeroLocalAgentDeviceClaimContract =
  typeof zeroLocalAgentDeviceClaimContract;
export type ZeroLocalAgentHeartbeatContract =
  typeof zeroLocalAgentHeartbeatContract;
export type ZeroLocalAgentHostRealtimeContract =
  typeof zeroLocalAgentHostRealtimeContract;
export type ZeroLocalAgentRunContract = typeof zeroLocalAgentRunContract;
export type ZeroLocalAgentHostsContract = typeof zeroLocalAgentHostsContract;
export type ZeroLocalAgentHostJobsContract =
  typeof zeroLocalAgentHostJobsContract;
