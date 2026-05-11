import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { ablyTokenRequestSchema } from "./realtime";

const c = initContract();

export const remoteAgentBackendSchema = z.enum(["codex", "claude-code"]);
export const remoteAgentJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export const remoteAgentHostStatusSchema = z.enum(["online", "closed"]);

const hostNameSchema = z.string().trim().min(1).max(128);
const supportedBackendsSchema = z.array(remoteAgentBackendSchema).min(1).max(2);
const promptSchema = z.string().trim().min(1).max(60_000);

const remoteAgentRealtimeSubscriptionSchema = z.object({
  channelName: z.string(),
  eventName: z.string(),
  tokenRequest: ablyTokenRequestSchema,
});

export const remoteAgentDeviceStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationPath: z.string(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
  pollToken: z.string(),
  realtime: remoteAgentRealtimeSubscriptionSchema.optional(),
});

export const remoteAgentDevicePollResponseSchema = z.discriminatedUnion(
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

export const remoteAgentDeviceClaimResponseSchema = z.object({
  status: z.literal("approved"),
});

export const remoteAgentHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  hostId: z.string(),
});

export const remoteAgentRunCreateResponseSchema = z.object({
  jobId: z.string(),
  status: remoteAgentJobStatusSchema,
});

export const remoteAgentRunResponseSchema = z.object({
  id: z.string(),
  hostId: z.string().nullable(),
  backend: remoteAgentBackendSchema.nullable(),
  prompt: z.string(),
  status: remoteAgentJobStatusSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const remoteAgentHostJobNextResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("idle") }),
    z.object({
      status: z.literal("job"),
      job: z.object({
        id: z.string(),
        backend: remoteAgentBackendSchema,
        prompt: z.string(),
      }),
    }),
  ],
);

export const remoteAgentHostJobCompleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const remoteAgentHostSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  supportedBackends: z.array(remoteAgentBackendSchema),
  status: remoteAgentHostStatusSchema,
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const remoteAgentHostListResponseSchema = z.object({
  hosts: z.array(remoteAgentHostSchema),
});

export const remoteAgentHostStartResponseSchema = z.object({
  hostId: z.string(),
  hostToken: z.string(),
});

export const remoteAgentHostDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const zeroRemoteAgentDeviceStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/remote-agent/device/start",
    body: z.object({
      hostName: hostNameSchema,
      supportedBackends: supportedBackendsSchema,
    }),
    responses: {
      200: remoteAgentDeviceStartResponseSchema,
      400: apiErrorSchema,
    },
    summary: "Start a remote-agent device pairing flow",
  },
});

export const zeroRemoteAgentDevicePollContract = c.router({
  poll: {
    method: "POST",
    path: "/api/zero/remote-agent/device/poll",
    body: z.object({
      deviceCode: z.string().min(1),
      pollToken: z.string().min(1),
    }),
    responses: {
      200: remoteAgentDevicePollResponseSchema,
      400: apiErrorSchema,
    },
    summary: "Poll a remote-agent device pairing flow",
  },
});

export const zeroRemoteAgentDeviceClaimContract = c.router({
  claim: {
    method: "POST",
    path: "/api/zero/remote-agent/device/claim",
    headers: authHeadersSchema,
    body: z.object({
      deviceCode: z.string().min(1),
    }),
    responses: {
      200: remoteAgentDeviceClaimResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Approve a remote-agent device pairing flow",
  },
});

export const zeroRemoteAgentHeartbeatContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/api/zero/remote-agent/heartbeat",
    headers: authHeadersSchema,
    body: z.object({
      hostName: hostNameSchema,
      supportedBackends: supportedBackendsSchema,
    }),
    responses: {
      200: remoteAgentHeartbeatResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Refresh a linked remote-agent host heartbeat",
  },
});

export const zeroRemoteAgentHostRealtimeContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/remote-agent/host/realtime-token",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: remoteAgentRealtimeSubscriptionSchema,
      401: apiErrorSchema,
    },
    summary: "Get Ably token for remote-agent host job notifications",
  },
});

export const zeroRemoteAgentRunContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/remote-agent/run",
    headers: authHeadersSchema,
    body: z.object({
      prompt: promptSchema,
      hostName: z.string().trim().min(1).max(128).optional(),
    }),
    responses: {
      200: remoteAgentRunCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a remote-agent job",
  },
  get: {
    method: "GET",
    path: "/api/zero/remote-agent/run/:jobId",
    pathParams: z.object({
      jobId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    responses: {
      200: remoteAgentRunResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a remote-agent job",
  },
});

export const zeroRemoteAgentHostsContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/remote-agent/hosts/start",
    headers: authHeadersSchema,
    body: z.object({
      hostName: hostNameSchema,
      supportedBackends: supportedBackendsSchema,
      hostId: z.string().min(1).optional(),
    }),
    responses: {
      200: remoteAgentHostStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Start or reactivate a remote-agent host",
  },
  list: {
    method: "GET",
    path: "/api/zero/remote-agent/hosts",
    headers: authHeadersSchema,
    responses: {
      200: remoteAgentHostListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List linked remote-agent hosts",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/remote-agent/hosts/:hostId",
    pathParams: z.object({
      hostId: z.string().min(1),
    }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: remoteAgentHostDeleteResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a remote-agent host",
  },
});

export const zeroRemoteAgentHostJobsContract = c.router({
  next: {
    method: "POST",
    path: "/api/zero/remote-agent/host/jobs/next",
    headers: authHeadersSchema,
    body: z.object({
      supportedBackends: supportedBackendsSchema,
    }),
    responses: {
      200: remoteAgentHostJobNextResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Claim the next remote-agent host job",
  },
  complete: {
    method: "POST",
    path: "/api/zero/remote-agent/host/jobs/:jobId/complete",
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
      200: remoteAgentHostJobCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Complete a remote-agent host job",
  },
});

export type RemoteAgentBackend = z.infer<typeof remoteAgentBackendSchema>;
export type RemoteAgentJobStatus = z.infer<typeof remoteAgentJobStatusSchema>;
export type RemoteAgentHostStatus = z.infer<typeof remoteAgentHostStatusSchema>;
export type RemoteAgentHost = z.infer<typeof remoteAgentHostSchema>;
export type RemoteAgentDeviceStartResponse = z.infer<
  typeof remoteAgentDeviceStartResponseSchema
>;
export type RemoteAgentRealtimeSubscription = z.infer<
  typeof remoteAgentRealtimeSubscriptionSchema
>;
export type RemoteAgentDevicePollResponse = z.infer<
  typeof remoteAgentDevicePollResponseSchema
>;
export type RemoteAgentRunCreateResponse = z.infer<
  typeof remoteAgentRunCreateResponseSchema
>;
export type RemoteAgentRunResponse = z.infer<
  typeof remoteAgentRunResponseSchema
>;
export type RemoteAgentHostListResponse = z.infer<
  typeof remoteAgentHostListResponseSchema
>;
export type RemoteAgentHostStartResponse = z.infer<
  typeof remoteAgentHostStartResponseSchema
>;
export type RemoteAgentHostDeleteResponse = z.infer<
  typeof remoteAgentHostDeleteResponseSchema
>;
export type RemoteAgentHostJobNextResponse = z.infer<
  typeof remoteAgentHostJobNextResponseSchema
>;
export type ZeroRemoteAgentDeviceStartContract =
  typeof zeroRemoteAgentDeviceStartContract;
export type ZeroRemoteAgentDevicePollContract =
  typeof zeroRemoteAgentDevicePollContract;
export type ZeroRemoteAgentDeviceClaimContract =
  typeof zeroRemoteAgentDeviceClaimContract;
export type ZeroRemoteAgentHeartbeatContract =
  typeof zeroRemoteAgentHeartbeatContract;
export type ZeroRemoteAgentHostRealtimeContract =
  typeof zeroRemoteAgentHostRealtimeContract;
export type ZeroRemoteAgentRunContract = typeof zeroRemoteAgentRunContract;
export type ZeroRemoteAgentHostsContract = typeof zeroRemoteAgentHostsContract;
export type ZeroRemoteAgentHostJobsContract =
  typeof zeroRemoteAgentHostJobsContract;
