import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import type {
  ScheduleCronCallbackPayload,
  ScheduleLoopCallbackPayload,
} from "../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../zero-run-service";

interface ScheduleTriggerContext {
  userId: string;
  agentId: string;
  scheduleId: string;
  prompt: string;
  appendSystemPrompt: string | undefined;
  triggerType: string;
  cronExpression: string | undefined;
  timezone: string;
  apiStartTime: number;
}

export function adaptScheduleTrigger(
  ctx: ScheduleTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt: ctx.appendSystemPrompt,
    scheduleId: ctx.scheduleId,
    triggerSource: "schedule",
    apiStartTime: ctx.apiStartTime,
    callbacks: buildScheduleCallbacks(ctx),
  };
}

function buildScheduleCallbacks(
  ctx: ScheduleTriggerContext,
): CreateZeroRunParams["callbacks"] {
  if (ctx.triggerType === "loop") {
    const payload: ScheduleLoopCallbackPayload = { scheduleId: ctx.scheduleId };
    return [
      {
        url: `${getApiUrl()}/api/internal/callbacks/schedule/loop`,
        secret: generateCallbackSecret(),
        payload,
      },
    ];
  }
  if (ctx.triggerType === "cron" || ctx.triggerType === "once") {
    const payload: ScheduleCronCallbackPayload = {
      scheduleId: ctx.scheduleId,
      ...(ctx.cronExpression && { cronExpression: ctx.cronExpression }),
      timezone: ctx.timezone,
    };
    return [
      {
        url: `${getApiUrl()}/api/internal/callbacks/schedule/cron`,
        secret: generateCallbackSecret(),
        payload,
      },
    ];
  }
  return [];
}
