import { z } from "zod";

/**
 * The flat single-trigger schedule projection. The interactive surfaces that
 * served it (/api/zero/schedules and the /api/automations alias) are gone
 * (#17307); the shape survives as the platform schedule pages' view model
 * over the automation resource API.
 */
export const scheduleResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  displayName: z.string().nullable(),
  userId: z.string(),
  name: z.string(),
  triggerType: z.enum(["cron", "once", "loop"]),
  cronExpression: z.string().nullable(),
  atTime: z.string().nullable(),
  intervalSeconds: z.number().nullable(),
  timezone: z.string(),
  prompt: z.string(),
  description: z.string().nullable(),
  appendSystemPrompt: z.string().nullable(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  retryStartedAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  // Linked chat thread. Set at creation and immutable after (any chatThreadId
  // supplied on update is ignored). Every schedule is linked to a chat thread,
  // so this is always present.
  chatThreadId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;
