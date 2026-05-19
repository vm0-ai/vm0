import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const computerUseHostStatusSchema = z.enum(["online", "offline"]);

export const computerUseReadCommandKindSchema = z.enum([
  "apps.list",
  "app.state",
]);

export const computerUseWriteCommandKindSchema = z.enum([
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
]);

export const computerUseCommandKindSchema = z.enum([
  ...computerUseReadCommandKindSchema.options,
  ...computerUseWriteCommandKindSchema.options,
]);

export const computerUseCommandStatusSchema = z.enum([
  "pending_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const computerUseCommandErrorCodeSchema = z.enum([
  "no_host",
  "permission_denied",
  "accessibility_unavailable",
  "screen_recording_unavailable",
  "unsupported_command",
  "timeout",
]);

const hostNameSchema = z.string().trim().min(1).max(128);
const hostVersionSchema = z.string().trim().min(1).max(64);
const hostOsVersionSchema = z.string().trim().min(1).max(128);
const hostIdPathParamsSchema = z.object({
  hostId: z.string().min(1),
});
const commandIdPathParamsSchema = z.object({
  commandId: z.string().min(1),
});
const supportedCapabilitiesSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(50);
const appNameSchema = z.string().trim().min(1).max(256);
const snapshotIdSchema = z.string().trim().min(1).max(256);
const elementIdSchema = z.string().trim().min(1).max(256);

const computerUsePermissionsSchema = z.object({
  accessibility: z.boolean(),
  screenRecording: z.boolean(),
});

const computerUseRuntimeBodySchema = z.object({
  hostName: hostNameSchema,
  appVersion: hostVersionSchema,
  osVersion: hostOsVersionSchema,
  supportedCapabilities: supportedCapabilitiesSchema.default([]),
  permissions: computerUsePermissionsSchema,
});

const computerUseCommandTargetShape = {
  hostId: z.string().min(1).optional(),
  hostName: hostNameSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
} as const;

const computerUseCommandPayloadShape = {
  app: appNameSchema.optional(),
  snapshotId: snapshotIdSchema.optional(),
  elementId: elementIdSchema.optional(),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  pages: z.number().positive().max(25).optional(),
  value: z.string().min(1).max(64_000).optional(),
  text: z.string().min(1).max(64_000).optional(),
  key: z.string().trim().min(1).max(256).optional(),
  action: z.string().trim().min(1).max(256).optional(),
} as const;

const computerUseCommandCreateBodySchema = z
  .object({
    kind: computerUseReadCommandKindSchema,
    ...computerUseCommandTargetShape,
    ...computerUseCommandPayloadShape,
  })
  .superRefine((body, ctx) => {
    if (body.kind === "app.state" && !body.app) {
      ctx.addIssue({
        code: "custom",
        path: ["app"],
        message: "app.state requires app",
      });
    }
  });

const computerUseWriteCommandCreateBaseSchema = z.object({
  kind: computerUseWriteCommandKindSchema,
  ...computerUseCommandTargetShape,
  ...computerUseCommandPayloadShape,
});

type ComputerUseWriteCommandCreateBody = z.infer<
  typeof computerUseWriteCommandCreateBaseSchema
>;

interface ComputerUseCommandValidationContext {
  addIssue(issue: {
    code: "custom";
    path: PropertyKey[];
    message: string;
  }): void;
}

function requireComputerUseField(
  ctx: ComputerUseCommandValidationContext,
  field: string,
  message: string,
): void {
  ctx.addIssue({ code: "custom", path: [field], message });
}

function validateElementClickCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  const hasPoint = body.x !== undefined && body.y !== undefined;
  if (!body.elementId && !hasPoint) {
    requireComputerUseField(
      ctx,
      "elementId",
      "element.click requires elementId or x/y",
    );
  }
  if ((body.x === undefined) !== (body.y === undefined)) {
    requireComputerUseField(
      ctx,
      "x",
      "element.click coordinates require both x and y",
    );
  }
}

function validateElementScrollCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.elementId) {
    requireComputerUseField(
      ctx,
      "elementId",
      "element.scroll requires elementId",
    );
  }
  if (!body.direction) {
    requireComputerUseField(
      ctx,
      "direction",
      "element.scroll requires direction",
    );
  }
}

function validateElementSetValueCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.elementId) {
    requireComputerUseField(
      ctx,
      "elementId",
      "element.set_value requires elementId",
    );
  }
  if (!body.value) {
    requireComputerUseField(ctx, "value", "element.set_value requires value");
  }
}

function validateElementActionCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.elementId) {
    requireComputerUseField(
      ctx,
      "elementId",
      "element.perform_action requires elementId",
    );
  }
  if (!body.action) {
    requireComputerUseField(
      ctx,
      "action",
      "element.perform_action requires action",
    );
  }
}

function validateComputerUseWriteCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.app) {
    requireComputerUseField(ctx, "app", `${body.kind} requires app`);
    return;
  }

  switch (body.kind) {
    case "app.open":
      return;
    case "element.click":
      validateElementClickCommand(body, ctx);
      return;
    case "element.scroll":
      validateElementScrollCommand(body, ctx);
      return;
    case "element.set_value":
      validateElementSetValueCommand(body, ctx);
      return;
    case "element.perform_action":
      validateElementActionCommand(body, ctx);
      return;
    case "keyboard.type_text":
      if (!body.text) {
        requireComputerUseField(
          ctx,
          "text",
          "keyboard.type_text requires text",
        );
      }
      return;
    case "keyboard.press_key":
      if (!body.key) {
        requireComputerUseField(ctx, "key", "keyboard.press_key requires key");
      }
  }
}

const computerUseWriteCommandCreateBodySchema =
  computerUseWriteCommandCreateBaseSchema.superRefine(
    validateComputerUseWriteCommand,
  );

const computerUseCommandErrorSchema = z.object({
  code: computerUseCommandErrorCodeSchema,
  message: z.string(),
});

const computerUseCommandResultSchema = z.record(z.string(), z.unknown());

export const computerUseHostSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  appVersion: z.string(),
  osVersion: z.string(),
  supportedCapabilities: z.array(z.string()),
  permissions: computerUsePermissionsSchema,
  status: computerUseHostStatusSchema,
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const computerUseHostStartResponseSchema = z.object({
  hostId: z.string(),
  hostToken: z.string(),
});

export const computerUseHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  hostId: z.string(),
});

export const computerUseHostListResponseSchema = z.object({
  hosts: z.array(computerUseHostSchema),
});

export const computerUseHostDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const computerUseCommandCreateResponseSchema = z.object({
  commandId: z.string(),
  status: z.enum(["queued", "pending_approval"]),
});

export const computerUseCommandResponseSchema = z.object({
  id: z.string(),
  kind: computerUseCommandKindSchema,
  status: computerUseCommandStatusSchema,
  hostId: z.string().nullable(),
  hostName: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  result: computerUseCommandResultSchema.optional(),
  error: computerUseCommandErrorSchema.optional(),
  timeoutMs: z.number().int().nullable(),
  createdAt: z.string(),
  claimedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const computerUseCommandApprovalBodySchema = z.object({
  decision: z.enum(["approve", "deny"]),
  message: z.string().max(512).optional(),
});

export const computerUseCommandApprovalResponseSchema = z.object({
  commandId: z.string(),
  status: z.enum(["queued", "failed"]),
});

export const computerUseHostCommandNextBodySchema = z.object({
  supportedCapabilities: supportedCapabilitiesSchema.default([]),
});

export const computerUseHostCommandNextResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("idle") }),
    z.object({
      status: z.literal("command"),
      command: computerUseCommandResponseSchema,
    }),
  ],
);

export const computerUseHostCommandCompleteBodySchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("succeeded"),
      result: computerUseCommandResultSchema,
    }),
    z.object({
      status: z.literal("failed"),
      error: computerUseCommandErrorSchema,
    }),
  ],
);

export const computerUseCommandCompleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const computerUseAuditEventSchema = z.object({
  id: z.string(),
  commandId: z.string(),
  runId: z.string().nullable(),
  hostId: z.string().nullable(),
  kind: computerUseWriteCommandKindSchema,
  app: z.string().nullable(),
  event: z.enum(["created", "approved", "denied", "completed"]),
  approvalOutcome: z.enum(["approved", "denied"]).nullable(),
  redactedResult: z.record(z.string(), z.unknown()).nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export const computerUseAuditEventListResponseSchema = z.object({
  auditEvents: z.array(computerUseAuditEventSchema),
});

export const zeroComputerUseHostsContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/computer-use/hosts/start",
    headers: authHeadersSchema,
    body: computerUseRuntimeBodySchema,
    responses: {
      200: computerUseHostStartResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Start or reactivate a desktop computer-use host",
  },
  list: {
    method: "GET",
    path: "/api/zero/computer-use/hosts",
    headers: authHeadersSchema,
    responses: {
      200: computerUseHostListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List linked desktop computer-use hosts",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/computer-use/hosts/:hostId",
    headers: authHeadersSchema,
    pathParams: hostIdPathParamsSchema,
    responses: {
      200: computerUseHostDeleteResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a desktop computer-use host",
  },
});

export const zeroComputerUseHeartbeatContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/api/zero/computer-use/heartbeat",
    headers: authHeadersSchema,
    body: computerUseRuntimeBodySchema,
    responses: {
      200: computerUseHeartbeatResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Refresh a desktop computer-use host heartbeat",
  },
});

export const zeroComputerUseCommandContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/computer-use/commands",
    headers: authHeadersSchema,
    body: computerUseCommandCreateBodySchema,
    responses: {
      200: computerUseCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a read-only desktop computer-use command",
  },
  get: {
    method: "GET",
    path: "/api/zero/computer-use/commands/:commandId",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    responses: {
      200: computerUseCommandResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a desktop computer-use command result",
  },
});

export const zeroComputerUseWriteCommandContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/computer-use/write-commands",
    headers: authHeadersSchema,
    body: computerUseWriteCommandCreateBodySchema,
    responses: {
      200: computerUseCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create an approved-write desktop computer-use command",
  },
});

export const zeroComputerUseCommandApprovalContract = c.router({
  decide: {
    method: "POST",
    path: "/api/zero/computer-use/commands/:commandId/approval",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    body: computerUseCommandApprovalBodySchema,
    responses: {
      200: computerUseCommandApprovalResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Approve or deny a pending desktop computer-use write command",
  },
});

export const zeroComputerUseHostCommandsContract = c.router({
  next: {
    method: "POST",
    path: "/api/zero/computer-use/host/commands/next",
    headers: authHeadersSchema,
    body: computerUseHostCommandNextBodySchema,
    responses: {
      200: computerUseHostCommandNextResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Claim the next approved desktop computer-use command",
  },
  complete: {
    method: "POST",
    path: "/api/zero/computer-use/host/commands/:commandId/complete",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    body: computerUseHostCommandCompleteBodySchema,
    responses: {
      200: computerUseCommandCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Complete a desktop computer-use command",
  },
});

export const zeroComputerUseAuditEventsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/computer-use/audit-events",
    headers: authHeadersSchema,
    query: z.object({
      limit: z.coerce.number().int().positive().max(200).default(50),
      commandId: z.string().optional(),
      hostId: z.string().optional(),
      runId: z.string().optional(),
    }),
    responses: {
      200: computerUseAuditEventListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List desktop computer-use write command audit events",
  },
});

export type ComputerUseAuditEvent = z.infer<typeof computerUseAuditEventSchema>;
export type ComputerUseAuditEventListResponse = z.infer<
  typeof computerUseAuditEventListResponseSchema
>;
export type ComputerUseCommandCreateResponse = z.infer<
  typeof computerUseCommandCreateResponseSchema
>;
export type ComputerUseCommandError = z.infer<
  typeof computerUseCommandErrorSchema
>;
export type ComputerUseCommandKind = z.infer<
  typeof computerUseCommandKindSchema
>;
export type ComputerUseCommandResponse = z.infer<
  typeof computerUseCommandResponseSchema
>;
export type ComputerUseCommandResult = z.infer<
  typeof computerUseCommandResultSchema
>;
export type ComputerUseCommandStatus = z.infer<
  typeof computerUseCommandStatusSchema
>;
export type ComputerUseHost = z.infer<typeof computerUseHostSchema>;
export type ComputerUseHostDeleteResponse = z.infer<
  typeof computerUseHostDeleteResponseSchema
>;
export type ComputerUseHostListResponse = z.infer<
  typeof computerUseHostListResponseSchema
>;
export type ComputerUseReadCommandKind = z.infer<
  typeof computerUseReadCommandKindSchema
>;
export type ComputerUseWriteCommandKind = z.infer<
  typeof computerUseWriteCommandKindSchema
>;
export type ZeroComputerUseAuditEventsContract =
  typeof zeroComputerUseAuditEventsContract;
export type ZeroComputerUseCommandApprovalContract =
  typeof zeroComputerUseCommandApprovalContract;
export type ZeroComputerUseCommandContract =
  typeof zeroComputerUseCommandContract;
export type ZeroComputerUseHeartbeatContract =
  typeof zeroComputerUseHeartbeatContract;
export type ZeroComputerUseHostCommandsContract =
  typeof zeroComputerUseHostCommandsContract;
export type ZeroComputerUseHostsContract = typeof zeroComputerUseHostsContract;
export type ZeroComputerUseWriteCommandContract =
  typeof zeroComputerUseWriteCommandContract;
