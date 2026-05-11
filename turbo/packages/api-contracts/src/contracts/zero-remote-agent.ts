import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const remoteAgentBackendSchema = z.enum(["codex", "claude-code"]);
export const remoteAgentJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

const hostNameSchema = z.string().trim().min(1).max(128);
const supportedBackendsSchema = z.array(remoteAgentBackendSchema).min(1).max(2);
const promptSchema = z.string().trim().min(1).max(60_000);

export const remoteAgentDeviceStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationPath: z.string(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
  pollToken: z.string(),
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
  hostId: z.string(),
  backend: remoteAgentBackendSchema,
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

export const zeroRemoteAgentDeviceStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/remote-agent/device/start",
    headers: authHeadersSchema,
    body: z.object({
      hostName: hostNameSchema,
      supportedBackends: supportedBackendsSchema,
    }),
    responses: {
      200: remoteAgentDeviceStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Start a remote-agent device pairing flow",
  },
});

export const zeroRemoteAgentDevicePollContract = c.router({
  poll: {
    method: "POST",
    path: "/api/zero/remote-agent/device/poll",
    headers: authHeadersSchema,
    body: z.object({
      deviceCode: z.string().min(1),
      pollToken: z.string().min(1),
    }),
    responses: {
      200: remoteAgentDevicePollResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
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

export const zeroRemoteAgentRunContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/remote-agent/run",
    headers: authHeadersSchema,
    body: z.object({
      backend: remoteAgentBackendSchema,
      prompt: promptSchema,
      hostId: z.string().optional(),
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
export type RemoteAgentDeviceStartResponse = z.infer<
  typeof remoteAgentDeviceStartResponseSchema
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
export type ZeroRemoteAgentRunContract = typeof zeroRemoteAgentRunContract;
export type ZeroRemoteAgentHostJobsContract =
  typeof zeroRemoteAgentHostJobsContract;
