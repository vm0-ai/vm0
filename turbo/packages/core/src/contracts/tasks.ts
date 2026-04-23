import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";

const c = initContract();

const taskTypeSchema = z.enum(["chat", "schedule", "slack", "email", "agent"]);

const taskAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

const taskItemSchema = z.object({
  id: z.string(),
  type: taskTypeSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  agent: taskAgentSchema,
  latestRunId: z.string().nullable(),
  status: runStatusSchema.nullable(),
  chatThreadId: z.string().optional(),
  scheduleId: z.string().optional(),
  slackThreadSessionId: z.string().optional(),
  emailThreadSessionId: z.string().optional(),
  agentRunId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const archiveTaskBodySchema = z.object({
  taskId: z.string(),
  taskType: taskTypeSchema,
  runId: z.string().nullable(),
});

const unarchiveTaskBodySchema = z.object({
  taskId: z.string(),
  taskType: taskTypeSchema,
});

export const tasksContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/tasks",
    headers: authHeadersSchema,
    query: z.object({
      agentId: z.string().optional(),
    }),
    responses: {
      200: z.object({ tasks: z.array(taskItemSchema) }),
      401: apiErrorSchema,
    },
    summary: "List unified tasks across all sources",
  },

  archive: {
    method: "POST",
    path: "/api/zero/tasks/archive",
    headers: authHeadersSchema,
    body: archiveTaskBodySchema,
    responses: {
      200: z.object({ ok: z.literal(true) }),
      401: apiErrorSchema,
    },
    summary: "Archive a task (exclude from task list until new run arrives)",
  },

  unarchive: {
    method: "POST",
    path: "/api/zero/tasks/unarchive",
    headers: authHeadersSchema,
    body: unarchiveTaskBodySchema,
    responses: {
      200: z.object({ ok: z.literal(true) }),
      401: apiErrorSchema,
    },
    summary: "Unarchive a task (restore to task list immediately)",
  },
});

export type TasksContract = typeof tasksContract;
export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type TaskAgent = z.infer<typeof taskAgentSchema>;
export type ArchiveTaskBody = z.infer<typeof archiveTaskBodySchema>;
export type UnarchiveTaskBody = z.infer<typeof unarchiveTaskBodySchema>;

export { taskItemSchema, taskTypeSchema, taskAgentSchema };
