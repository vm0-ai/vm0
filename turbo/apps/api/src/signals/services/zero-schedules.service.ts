import { createDecipheriv } from "node:crypto";

import { computed, type Computed } from "ccstate";
import type {
  ScheduleListResponse,
  ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { db$ } from "../external/db";

const secretsMapSchema = z.record(z.string(), z.string());

function decryptSecretsMap(
  encryptedData: string | null,
): Record<string, string> | null {
  if (!encryptedData) {
    return null;
  }

  const key = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  const [ivBase64, authTagBase64, dataBase64] = encryptedData.split(":");
  if (!ivBase64 || !authTagBase64 || !dataBase64) {
    throw new Error("Invalid encrypted secrets format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivBase64, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataBase64, "base64")),
    decipher.final(),
  ]);

  return secretsMapSchema.parse(JSON.parse(decrypted.toString("utf8")));
}

function scheduleResponse(
  schedule: typeof zeroAgentSchedules.$inferSelect,
  displayName: string | null,
): ScheduleResponse {
  const secrets = decryptSecretsMap(schedule.encryptedSecrets);
  return {
    id: schedule.id,
    agentId: schedule.agentId,
    displayName,
    userId: schedule.userId,
    name: schedule.name,
    triggerType: schedule.triggerType as "cron" | "once" | "loop",
    cronExpression: schedule.cronExpression,
    atTime: schedule.atTime?.toISOString() ?? null,
    intervalSeconds: schedule.intervalSeconds,
    timezone: schedule.timezone,
    prompt: schedule.prompt,
    description: schedule.description,
    appendSystemPrompt: schedule.appendSystemPrompt,
    vars: schedule.vars,
    secretNames: secrets ? Object.keys(secrets) : null,
    volumeVersions: schedule.volumeVersions,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    retryStartedAt: schedule.retryStartedAt?.toISOString() ?? null,
    consecutiveFailures: schedule.consecutiveFailures,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
    modelProviderId: schedule.modelProviderId ?? null,
    selectedModel: schedule.selectedModel ?? null,
  };
}

export function zeroScheduleList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ScheduleListResponse>> {
  return computed(async (get): Promise<ScheduleListResponse> => {
    const db = get(db$);
    const schedules = await db
      .select()
      .from(zeroAgentSchedules)
      .where(
        and(
          eq(zeroAgentSchedules.userId, args.userId),
          eq(zeroAgentSchedules.orgId, args.orgId),
        ),
      );

    if (schedules.length === 0) {
      return { schedules: [] };
    }

    const agentRows = await db
      .select({
        id: agentComposes.id,
        displayName: zeroAgents.displayName,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        inArray(
          agentComposes.id,
          schedules.map((schedule) => {
            return schedule.agentId;
          }),
        ),
      );
    const agentMap = new Map(
      agentRows.map((row) => {
        return [row.id, row.displayName] as const;
      }),
    );

    return {
      schedules: schedules.flatMap((schedule) => {
        if (!agentMap.has(schedule.agentId)) {
          return [];
        }
        return [
          scheduleResponse(schedule, agentMap.get(schedule.agentId) ?? null),
        ];
      }),
    };
  });
}
