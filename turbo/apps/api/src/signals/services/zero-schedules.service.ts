import { createDecipheriv } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import type {
  ScheduleListResponse,
  ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { Cron } from "croner";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { db$, writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";

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
    preferPersonalProvider: schedule.preferPersonalProvider ?? false,
  };
}

function calculateNextRun(
  cronExpression: string,
  timezone: string,
): Date | null {
  return new Cron(cronExpression, { timezone }).nextRun();
}

type OwnershipResult =
  | {
      readonly ok: true;
      readonly schedule: typeof zeroAgentSchedules.$inferSelect;
      readonly displayName: string | null;
    }
  | { readonly ok: false };

async function verifyScheduleOwnership(
  db: Db,
  userId: string,
  orgId: string,
  agentId: string,
  name: string,
): Promise<OwnershipResult> {
  const [agent] = await db
    .select({
      id: agentComposes.id,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.id, agentId))
    .limit(1);
  if (!agent) {
    return { ok: false };
  }

  const [schedule] = await db
    .select()
    .from(zeroAgentSchedules)
    .where(
      and(
        eq(zeroAgentSchedules.agentId, agentId),
        eq(zeroAgentSchedules.name, name),
        eq(zeroAgentSchedules.orgId, orgId),
        eq(zeroAgentSchedules.userId, userId),
      ),
    )
    .limit(1);
  if (!schedule) {
    return { ok: false };
  }

  return { ok: true, schedule, displayName: agent.displayName ?? null };
}

type DisableScheduleResult =
  | { readonly kind: "ok"; readonly response: ScheduleResponse }
  | { readonly kind: "not_found" };

type DeleteScheduleResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not_found" };

type EnableScheduleResult =
  | { readonly kind: "ok"; readonly response: ScheduleResponse }
  | { readonly kind: "not_found" }
  | { readonly kind: "schedule_past" };

interface ScheduleMutationArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly name: string;
}

export const disableSchedule$ = command(
  async (
    { set },
    args: ScheduleMutationArgs,
    signal: AbortSignal,
  ): Promise<DisableScheduleResult> => {
    const db = set(writeDb$);
    const ownership = await verifyScheduleOwnership(
      db,
      args.userId,
      args.orgId,
      args.agentId,
      args.name,
    );
    signal.throwIfAborted();
    if (!ownership.ok) {
      return { kind: "not_found" };
    }

    const [updated] = await db
      .update(zeroAgentSchedules)
      .set({
        enabled: false,
        retryStartedAt: null,
        updatedAt: nowDate(),
      })
      .where(eq(zeroAgentSchedules.id, ownership.schedule.id))
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "not_found" };
    }

    return {
      kind: "ok",
      response: scheduleResponse(updated, ownership.displayName),
    };
  },
);

export const deleteSchedule$ = command(
  async (
    { set },
    args: ScheduleMutationArgs,
    signal: AbortSignal,
  ): Promise<DeleteScheduleResult> => {
    const db = set(writeDb$);
    const ownership = await verifyScheduleOwnership(
      db,
      args.userId,
      args.orgId,
      args.agentId,
      args.name,
    );
    signal.throwIfAborted();
    if (!ownership.ok) {
      return { kind: "not_found" };
    }

    const [deleted] = await db
      .delete(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.id, ownership.schedule.id))
      .returning({ id: zeroAgentSchedules.id });
    signal.throwIfAborted();
    if (!deleted) {
      return { kind: "not_found" };
    }

    return { kind: "ok" };
  },
);

export const enableSchedule$ = command(
  async (
    { set },
    args: ScheduleMutationArgs,
    signal: AbortSignal,
  ): Promise<EnableScheduleResult> => {
    const db = set(writeDb$);
    const ownership = await verifyScheduleOwnership(
      db,
      args.userId,
      args.orgId,
      args.agentId,
      args.name,
    );
    signal.throwIfAborted();
    if (!ownership.ok) {
      return { kind: "not_found" };
    }
    const { schedule, displayName } = ownership;

    const now = nowDate();
    let nextRunAt: Date | null = null;
    if (schedule.triggerType === "loop") {
      nextRunAt = now;
    } else if (schedule.cronExpression) {
      nextRunAt = calculateNextRun(schedule.cronExpression, schedule.timezone);
    } else if (schedule.atTime) {
      if (schedule.atTime > now) {
        nextRunAt = schedule.atTime;
      } else {
        return { kind: "schedule_past" };
      }
    }

    const [updated] = await db
      .update(zeroAgentSchedules)
      .set({
        enabled: true,
        nextRunAt,
        retryStartedAt: null,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(zeroAgentSchedules.id, schedule.id))
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "not_found" };
    }

    return {
      kind: "ok",
      response: scheduleResponse(updated, displayName),
    };
  },
);

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
