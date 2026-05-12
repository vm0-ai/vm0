import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { voiceChatSessions, voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { and, eq, inArray } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface VoiceChatFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly sessionIds: readonly string[];
}

interface SessionSeed {
  readonly userId?: string;
  readonly orgId?: string;
  readonly createdAt?: Date;
}

interface SeedValues {
  readonly trinityEnabled?: boolean;
  readonly sessions?: readonly SessionSeed[];
}

export const seedVoiceChatFixture$ = command(
  async (
    { set },
    values: SeedValues,
    signal: AbortSignal,
  ): Promise<VoiceChatFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    if (values.trinityEnabled) {
      await writeDb.insert(userFeatureSwitches).values({
        orgId,
        userId,
        switches: { trinity: true },
      });
      signal.throwIfAborted();
    }

    const sessionIds: string[] = [];
    for (const session of values.sessions ?? []) {
      const id = randomUUID();
      sessionIds.push(id);
      await writeDb.insert(voiceChatSessions).values({
        id,
        orgId: session.orgId ?? orgId,
        userId: session.userId ?? userId,
        ...(session.createdAt !== undefined
          ? { createdAt: session.createdAt }
          : {}),
      });
      signal.throwIfAborted();
    }

    return { orgId, userId, sessionIds };
  },
);

interface TaskSeed {
  readonly status: "pending" | "queued" | "running" | "done" | "failed";
  readonly runId?: string | null;
  readonly prompt?: string;
  readonly result?: string | null;
  readonly assistantMessages?: readonly {
    readonly type: "assistant";
    readonly content: string;
    readonly at: string;
  }[];
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
}

export const seedVoiceChatTask$ = command(
  async (
    { set },
    sessionId: string,
    values: TaskSeed,
    signal: AbortSignal,
  ): Promise<string> => {
    const writeDb = set(writeDb$);
    const id = randomUUID();
    await writeDb.insert(voiceChatTasks).values({
      id,
      sessionId,
      callId: `call_${randomUUID()}`,
      prompt: values.prompt ?? "test",
      status: values.status,
      ...(values.runId !== undefined ? { runId: values.runId } : {}),
      ...(values.result !== undefined ? { result: values.result } : {}),
      ...(values.assistantMessages !== undefined
        ? { assistantMessages: [...values.assistantMessages] }
        : {}),
      ...(values.startedAt !== undefined
        ? { startedAt: values.startedAt }
        : {}),
      ...(values.finishedAt !== undefined
        ? { finishedAt: values.finishedAt }
        : {}),
    });
    signal.throwIfAborted();
    return id;
  },
);

export const deleteVoiceChatFixture$ = command(
  async (
    { set },
    fixture: VoiceChatFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    if (fixture.sessionIds.length > 0) {
      await writeDb
        .delete(voiceChatSessions)
        .where(inArray(voiceChatSessions.id, [...fixture.sessionIds]));
      signal.throwIfAborted();
    }
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
