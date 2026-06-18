import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroWorkflowVisibilitySchema = z.enum(["public", "private"]);
export type ZeroWorkflowVisibility = z.infer<
  typeof zeroWorkflowVisibilitySchema
>;

/**
 * Workflow name validation regex.
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 * Minimum 2 characters.
 */
export const zeroWorkflowNameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

/**
 * Single file entry in a workflow upload.
 *
 * The backing package remains a skill directory, so uploads must include a
 * root SKILL.md file.
 */
export const workflowFileEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (p) => {
        return !p.startsWith("/");
      },
      { message: "Path must be relative" },
    )
    .refine(
      (p) => {
        return !p.includes("..");
      },
      {
        message: "Path must not contain ..",
      },
    ),
  content: z.string(),
});

const WORKFLOW_FILES_MAX_BYTES = 5 * 1024 * 1024;
const WORKFLOW_FILES_MAX_COUNT = 500;

export const workflowFilesSchema = z
  .array(workflowFileEntrySchema)
  .min(1, "At least one file is required")
  .max(
    WORKFLOW_FILES_MAX_COUNT,
    `Maximum ${WORKFLOW_FILES_MAX_COUNT} files allowed`,
  )
  .refine(
    (files) => {
      return files.some((f) => {
        return f.path === "SKILL.md";
      });
    },
    {
      message: "SKILL.md is required",
    },
  )
  .refine(
    (files) => {
      const total = files.reduce((sum, f) => {
        return sum + new TextEncoder().encode(f.content).length;
      }, 0);
      return total <= WORKFLOW_FILES_MAX_BYTES;
    },
    { message: "Total file size must not exceed 5MB" },
  );

export const workflowFileMetadataSchema = z.object({
  path: z.string(),
  size: z.number(),
});

export const zeroWorkflowAgentSummarySchema = z.object({
  agentId: z.string().uuid(),
  ownerId: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  visibility: z.enum(["public", "private"]),
});

export const zeroWorkflowTriggerKindSchema = z.enum([
  "schedule",
  "event",
  "webhook",
]);
export type ZeroWorkflowTriggerKind = z.infer<
  typeof zeroWorkflowTriggerKindSchema
>;

export const zeroWorkflowScheduleTypeSchema = z.enum(["cron", "loop", "once"]);
export type ZeroWorkflowScheduleType = z.infer<
  typeof zeroWorkflowScheduleTypeSchema
>;

/**
 * Schedule configuration, discriminated by `type`. Aligned with Automation's
 * time-trigger model so the same scheduling primitives can be reused:
 * - `cron`: recurring at wall-clock times.
 * - `loop`: re-scheduled `intervalSeconds` after each completion.
 * - `once`: fires once at `atTime`, then auto-disables.
 */
export const zeroWorkflowScheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    cronExpression: z.string().min(1).max(100),
    timezone: z.string().min(1),
  }),
  z.object({
    type: z.literal("loop"),
    intervalSeconds: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("once"),
    atTime: z.string().datetime(),
    timezone: z.string().min(1),
  }),
]);
export type ZeroWorkflowSchedule = z.infer<typeof zeroWorkflowScheduleSchema>;

/**
 * Trigger summary. The workflow is the named parent; triggers have no name and
 * are identified by their schedule. `kind` is always `schedule` for now.
 */
export const zeroWorkflowTriggerSummarySchema = z.object({
  id: z.string(),
  kind: zeroWorkflowTriggerKindSchema,
  schedule: zeroWorkflowScheduleSchema,
  scheduleSummary: z.string(),
  agentId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  chatThreadId: z.string().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});
export type ZeroWorkflowTriggerSummary = z.infer<
  typeof zeroWorkflowTriggerSummarySchema
>;

export const zeroWorkflowTriggerCreateRequestSchema = z.object({
  agentId: z.string().uuid(),
  schedule: zeroWorkflowScheduleSchema,
  enabled: z.boolean().optional(),
});
export type ZeroWorkflowTriggerCreateRequest = z.infer<
  typeof zeroWorkflowTriggerCreateRequestSchema
>;

export const zeroWorkflowTriggerUpdateRequestSchema = z
  .object({
    agentId: z.string().uuid().optional(),
    schedule: zeroWorkflowScheduleSchema.optional(),
  })
  .refine(
    (body) => {
      return body.agentId !== undefined || body.schedule !== undefined;
    },
    { message: "At least one trigger update is required" },
  );
export type ZeroWorkflowTriggerUpdateRequest = z.infer<
  typeof zeroWorkflowTriggerUpdateRequestSchema
>;

export const zeroWorkflowSummarySchema = z.object({
  name: zeroWorkflowNameSchema,
  displayName: z.string().max(256).nullable(),
  description: z.string().max(1024).nullable(),
  visibility: zeroWorkflowVisibilitySchema,
  ownerUserId: z.string(),
  attachedAgentCount: z.number(),
  attachedAgents: z.array(zeroWorkflowAgentSummarySchema),
  canManage: z.boolean(),
});

export const zeroWorkflowContentResponseSchema =
  zeroWorkflowSummarySchema.extend({
    content: z.string().nullable(),
    files: z.array(workflowFileMetadataSchema).nullable(),
  });

export const zeroWorkflowDetailResponseSchema =
  zeroWorkflowContentResponseSchema.extend({
    fileContents: z.array(workflowFileEntrySchema).nullable(),
    triggers: z.array(zeroWorkflowTriggerSummarySchema),
  });

export const zeroWorkflowListResponseSchema = z.array(
  zeroWorkflowSummarySchema,
);

export const zeroWorkflowCreateRequestSchema = z.object({
  name: zeroWorkflowNameSchema,
  files: workflowFilesSchema,
  displayName: z.string().max(256).optional(),
  description: z.string().max(1024).optional(),
  visibility: zeroWorkflowVisibilitySchema.optional(),
});

export const zeroWorkflowUpdateRequestSchema = z
  .object({
    files: workflowFilesSchema.optional(),
    displayName: z.string().max(256).nullable().optional(),
    description: z.string().max(1024).nullable().optional(),
    visibility: zeroWorkflowVisibilitySchema.optional(),
  })
  .refine(
    (body) => {
      return (
        body.files !== undefined ||
        body.displayName !== undefined ||
        body.description !== undefined ||
        body.visibility !== undefined
      );
    },
    { message: "At least one workflow update is required" },
  );

export const zeroWorkflowAttachAgentRequestSchema = z.object({
  agentId: z.string().uuid(),
});

export const zeroWorkflowSetAgentsRequestSchema = z.object({
  agentIds: z.array(z.string().uuid()),
});

export const zeroWorkflowsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/workflows",
    headers: authHeadersSchema,
    responses: {
      200: zeroWorkflowListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List visible workflows in the organization",
  },
  create: {
    method: "POST",
    path: "/api/zero/workflows",
    headers: authHeadersSchema,
    body: zeroWorkflowCreateRequestSchema,
    responses: {
      201: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a workflow in the organization",
  },
});

export const zeroWorkflowsDetailContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/workflows/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    responses: {
      200: zeroWorkflowDetailResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get workflow with content",
  },
  update: {
    method: "PUT",
    path: "/api/zero/workflows/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    body: zeroWorkflowUpdateRequestSchema,
    responses: {
      200: zeroWorkflowContentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update workflow content or metadata",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/workflows/:name",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete workflow from the organization",
  },
});

export const zeroWorkflowAgentsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/workflows/:name/agents",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    responses: {
      200: z.array(zeroWorkflowAgentSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List workflow agent attachments",
  },
  attach: {
    method: "POST",
    path: "/api/zero/workflows/:name/agents",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    body: zeroWorkflowAttachAgentRequestSchema,
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Attach workflow to an agent",
  },
  set: {
    method: "PUT",
    path: "/api/zero/workflows/:name/agents",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    body: zeroWorkflowSetAgentsRequestSchema,
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Replace workflow agent attachments",
  },
  detach: {
    method: "DELETE",
    path: "/api/zero/workflows/:name/agents/:agentId",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: zeroWorkflowNameSchema,
      agentId: z.string().uuid(),
    }),
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Detach workflow from an agent",
  },
});

const triggerIdParams = z.object({ id: z.string().uuid() });

export const zeroWorkflowTriggersContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/workflows/:name/triggers",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    responses: {
      200: z.array(zeroWorkflowTriggerSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List schedule triggers for a workflow",
  },
  create: {
    method: "POST",
    path: "/api/zero/workflows/:name/triggers",
    headers: authHeadersSchema,
    pathParams: z.object({ name: zeroWorkflowNameSchema }),
    body: zeroWorkflowTriggerCreateRequestSchema,
    responses: {
      201: zeroWorkflowTriggerSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a schedule trigger on a workflow",
  },
  get: {
    method: "GET",
    path: "/api/zero/workflow-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a workflow schedule trigger",
  },
  update: {
    method: "PATCH",
    path: "/api/zero/workflow-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: zeroWorkflowTriggerUpdateRequestSchema,
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update a workflow schedule trigger",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/workflow-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a workflow schedule trigger",
  },
  enable: {
    method: "POST",
    path: "/api/zero/workflow-triggers/:id/enable",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Enable a workflow schedule trigger",
  },
  disable: {
    method: "POST",
    path: "/api/zero/workflow-triggers/:id/disable",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable a workflow schedule trigger",
  },
});

export type WorkflowFileEntry = z.infer<typeof workflowFileEntrySchema>;
export type WorkflowFileMetadata = z.infer<typeof workflowFileMetadataSchema>;
export type ZeroWorkflowAgentSummary = z.infer<
  typeof zeroWorkflowAgentSummarySchema
>;
export type ZeroWorkflowSummary = z.infer<typeof zeroWorkflowSummarySchema>;
export type ZeroWorkflowContentResponse = z.infer<
  typeof zeroWorkflowContentResponseSchema
>;
export type ZeroWorkflowDetailResponse = z.infer<
  typeof zeroWorkflowDetailResponseSchema
>;
export type ZeroWorkflowCreateRequest = z.infer<
  typeof zeroWorkflowCreateRequestSchema
>;
export type ZeroWorkflowUpdateRequest = z.infer<
  typeof zeroWorkflowUpdateRequestSchema
>;
export type ZeroWorkflowsCollectionContract =
  typeof zeroWorkflowsCollectionContract;
export type ZeroWorkflowsDetailContract = typeof zeroWorkflowsDetailContract;
export type ZeroWorkflowAgentsContract = typeof zeroWorkflowAgentsContract;
export type ZeroWorkflowTriggersContract = typeof zeroWorkflowTriggersContract;
