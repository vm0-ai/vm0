import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroWorkflowVisibilitySchema = z.enum(["public", "private"]);
export type ZeroWorkflowVisibility = z.infer<
  typeof zeroWorkflowVisibilitySchema
>;

/**
 * Workflow name (slug) validation regex.
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 * Minimum 2 characters. Slugs are NOT unique — duplicates across and within an
 * agent are allowed; run-time picks a winner by a fixed priority rule.
 */
export const zeroWorkflowNameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

/**
 * Reserved file name. `SKILL.md` is synthesized server-side from the workflow's
 * (name, description, instruction); users never author or see it.
 */
export const RESERVED_SKILL_FILE = "SKILL.md";

/**
 * A single attached (supplementary) file. The synthesized SKILL.md is never
 * part of this set — `SKILL.md` is a reserved path and is rejected.
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
      { message: "Path must not contain .." },
    )
    .refine(
      (p) => {
        return p !== RESERVED_SKILL_FILE;
      },
      { message: "SKILL.md is reserved and is generated automatically" },
    ),
  content: z.string(),
});

const WORKFLOW_FILES_MAX_BYTES = 5 * 1024 * 1024;
const WORKFLOW_FILES_MAX_COUNT = 500;

/**
 * Attached files (excluding the synthesized SKILL.md). May be empty.
 */
export const workflowFilesSchema = z
  .array(workflowFileEntrySchema)
  .max(
    WORKFLOW_FILES_MAX_COUNT,
    `Maximum ${WORKFLOW_FILES_MAX_COUNT} files allowed`,
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

export const workflowInstructionSchema = z
  .string()
  .max(WORKFLOW_FILES_MAX_BYTES);

export const zeroWorkflowScheduleTypeSchema = z.enum(["cron", "loop", "once"]);
export type ZeroWorkflowScheduleType = z.infer<
  typeof zeroWorkflowScheduleTypeSchema
>;

export const zeroWorkflowTriggerKindSchema = z.enum(["schedule", "event"]);
export type ZeroWorkflowTriggerKind = z.infer<
  typeof zeroWorkflowTriggerKindSchema
>;

/**
 * Schedule configuration, discriminated by `type`. Aligned with Automation's
 * time-trigger model:
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
 * Trigger summary. Under 1:N the agent is derived from the workflow, so triggers
 * no longer carry an agentId. Detail responses only ever list the caller's own
 * triggers.
 */
export const zeroWorkflowTriggerSummarySchema = z.object({
  id: z.string(),
  kind: zeroWorkflowTriggerKindSchema,
  schedule: zeroWorkflowScheduleSchema,
  scheduleSummary: z.string(),
  ownerUserId: z.string(),
  enabled: z.boolean(),
  chatThreadId: z.string().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});
export type ZeroWorkflowTriggerSummary = z.infer<
  typeof zeroWorkflowTriggerSummarySchema
>;

export const zeroWorkflowTriggerCreateRequestSchema = z.object({
  schedule: zeroWorkflowScheduleSchema,
  enabled: z.boolean().optional(),
});
export type ZeroWorkflowTriggerCreateRequest = z.infer<
  typeof zeroWorkflowTriggerCreateRequestSchema
>;

export const zeroWorkflowTriggerUpdateRequestSchema = z.object({
  schedule: zeroWorkflowScheduleSchema,
});
export type ZeroWorkflowTriggerUpdateRequest = z.infer<
  typeof zeroWorkflowTriggerUpdateRequestSchema
>;

/**
 * Workflow summary. A workflow belongs to exactly one agent (`agentId`).
 * `requestToPublish` is only meaningful while `visibility = 'private'`.
 * `canManage` reflects the caller's effective rights (agent write-permission
 * for public workflows; ownership for private ones).
 */
export const zeroWorkflowSummarySchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string().nullable(),
  agentDisplayName: z.string().nullable(),
  name: zeroWorkflowNameSchema,
  displayName: z.string().max(256).nullable(),
  description: z.string().max(1024).nullable(),
  visibility: zeroWorkflowVisibilitySchema,
  requestToPublish: z.boolean(),
  ownerUserId: z.string(),
  canManage: z.boolean(),
  shadowedBy: z
    .object({
      id: z.string().uuid(),
      name: zeroWorkflowNameSchema,
      displayName: z.string().max(256).nullable(),
    })
    .nullable()
    .optional(),
});

export const zeroWorkflowDetailResponseSchema =
  zeroWorkflowSummarySchema.extend({
    instruction: z.string().nullable(),
    files: z.array(workflowFileMetadataSchema).nullable(),
    fileContents: z.array(workflowFileEntrySchema).nullable(),
    triggers: z.array(zeroWorkflowTriggerSummarySchema),
  });

export const zeroWorkflowListResponseSchema = z.array(
  zeroWorkflowSummarySchema,
);

export const zeroWorkflowCreateRequestSchema = z.object({
  agentId: z.string().uuid(),
  name: zeroWorkflowNameSchema,
  instruction: workflowInstructionSchema.optional(),
  files: workflowFilesSchema.optional(),
  displayName: z.string().max(256).optional(),
  description: z.string().max(1024).optional(),
  visibility: zeroWorkflowVisibilitySchema.optional(),
});

export const zeroWorkflowUpdateRequestSchema = z
  .object({
    instruction: workflowInstructionSchema.nullable().optional(),
    files: workflowFilesSchema.optional(),
    displayName: z.string().max(256).nullable().optional(),
    description: z.string().max(1024).nullable().optional(),
  })
  .refine(
    (body) => {
      return (
        body.instruction !== undefined ||
        body.files !== undefined ||
        body.displayName !== undefined ||
        body.description !== undefined
      );
    },
    { message: "At least one workflow update is required" },
  );

export const zeroWorkflowCopyRequestSchema = z.object({
  toAgentId: z.string().uuid(),
});

export const zeroWorkflowRunResponseSchema = z.object({
  chatThreadId: z.string().uuid(),
  runId: z.string(),
});

const workflowIdParams = z.object({ workflowId: z.string().uuid() });

export const zeroWorkflowsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/workflows",
    headers: authHeadersSchema,
    query: z.object({ agentId: z.string().uuid().optional() }),
    responses: {
      200: zeroWorkflowListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List visible workflows, optionally scoped to one agent",
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
      404: apiErrorSchema,
    },
    summary: "Create a workflow under an agent",
  },
});

export const zeroWorkflowsDetailContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: zeroWorkflowDetailResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a workflow with its instruction and files",
  },
  update: {
    method: "PATCH",
    path: "/api/zero/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: zeroWorkflowUpdateRequestSchema,
    responses: {
      200: zeroWorkflowDetailResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a workflow's instruction, files, or metadata",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a workflow",
  },
  copy: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/copy",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: zeroWorkflowCopyRequestSchema,
    responses: {
      201: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Copy (fork) a workflow onto another agent",
  },
  run: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/run",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowRunResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Run the workflow once in a new chat thread (equivalent to /slug)",
  },
});

/**
 * Visibility transitions. A private workflow whose owner lacks agent
 * write-permission flows through request -> approve/reject; an owner with agent
 * write-permission publishes directly. Demotion is an agent-write operation.
 */
export const zeroWorkflowVisibilityContract = c.router({
  requestPublish: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/request-publish",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Owner requests promotion to public (auto-approves if owner has agent write-permission)",
  },
  cancelPublishRequest: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/cancel-publish-request",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Owner withdraws a pending publish request",
  },
  approvePublish: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/approve-publish",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Agent write-permission holder approves a pending publish request",
  },
  rejectPublish: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/reject-publish",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Agent write-permission holder rejects a pending publish request",
  },
  demote: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/demote",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Agent write-permission holder demotes a public workflow to private",
  },
});

const triggerIdParams = z.object({ id: z.string().uuid() });

export const zeroWorkflowTriggersContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/workflows/:workflowId/triggers",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: z.array(zeroWorkflowTriggerSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List the caller's own triggers for a workflow",
  },
  create: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/triggers",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
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
  run: {
    method: "POST",
    path: "/api/zero/workflow-triggers/:id/run",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      200: z.object({ runId: z.string() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Fire a one-off test run of a workflow schedule trigger",
  },
});

export type WorkflowFileEntry = z.infer<typeof workflowFileEntrySchema>;
export type WorkflowFileMetadata = z.infer<typeof workflowFileMetadataSchema>;
export type ZeroWorkflowSummary = z.infer<typeof zeroWorkflowSummarySchema>;
export type ZeroWorkflowDetailResponse = z.infer<
  typeof zeroWorkflowDetailResponseSchema
>;
export type ZeroWorkflowCreateRequest = z.infer<
  typeof zeroWorkflowCreateRequestSchema
>;
export type ZeroWorkflowUpdateRequest = z.infer<
  typeof zeroWorkflowUpdateRequestSchema
>;
export type ZeroWorkflowCopyRequest = z.infer<
  typeof zeroWorkflowCopyRequestSchema
>;
export type ZeroWorkflowRunResponse = z.infer<
  typeof zeroWorkflowRunResponseSchema
>;
export type ZeroWorkflowsCollectionContract =
  typeof zeroWorkflowsCollectionContract;
export type ZeroWorkflowsDetailContract = typeof zeroWorkflowsDetailContract;
export type ZeroWorkflowVisibilityContract =
  typeof zeroWorkflowVisibilityContract;
export type ZeroWorkflowTriggersContract = typeof zeroWorkflowTriggersContract;
