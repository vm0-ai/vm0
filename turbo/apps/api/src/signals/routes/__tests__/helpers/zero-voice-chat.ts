import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { voiceChatSessions, voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray, or } from "drizzle-orm";

import { nowDate } from "../../../../lib/time";
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
  readonly realtimeBillingEnabled?: boolean;
  readonly credits?: number;
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
        switches: {
          trinity: true,
          ...(values.realtimeBillingEnabled
            ? { voiceChatRealtimeBilling: true }
            : {}),
        },
      });
      signal.throwIfAborted();
    }

    if (values.credits !== undefined) {
      await writeDb.insert(orgMetadata).values({
        orgId,
        credits: values.credits,
      });
      signal.throwIfAborted();
      await writeDb.insert(orgMembersMetadata).values({
        orgId,
        userId,
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

export const seedVoiceChatAgent$ = command(
  async (
    { set },
    fixture: VoiceChatFixture,
    args: {
      readonly environment?: Record<string, string>;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const writeDb = set(writeDb$);
    const agentId = randomUUID();
    const versionId = randomUUID();
    const name = `voice-${agentId.slice(0, 8)}`;

    await writeDb.insert(agentComposes).values({
      id: agentId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      name,
    });
    signal.throwIfAborted();
    await writeDb.insert(zeroAgents).values({
      id: agentId,
      orgId: fixture.orgId,
      owner: fixture.userId,
      name,
    });
    signal.throwIfAborted();
    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId: agentId,
      content: {
        version: "1.0",
        agents: {
          main: {
            framework: "claude-code",
            description: "Voice test agent",
            environment: args.environment ?? { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
      createdBy: fixture.userId,
    });
    signal.throwIfAborted();
    await writeDb
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, agentId));
    signal.throwIfAborted();

    return agentId;
  },
);

export const addVoiceChatSession$ = command(
  async (
    { set },
    fixture: VoiceChatFixture,
    args: { readonly agentId?: string | null },
    signal: AbortSignal,
  ): Promise<string> => {
    const writeDb = set(writeDb$);
    const [session] = await writeDb
      .insert(voiceChatSessions)
      .values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: args.agentId ?? null,
      })
      .returning({ id: voiceChatSessions.id });
    signal.throwIfAborted();
    if (!session) {
      throw new Error("addVoiceChatSession$: insert returned no row");
    }
    return session.id;
  },
);

export const seedVoiceChatRealtimePricing$ = command(
  async ({ set }, _signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    const realtimeCategories = [
      "tokens.input.text",
      "tokens.input.audio",
      "tokens.input.cached_text",
      "tokens.input.cached_audio",
      "tokens.output.text",
      "tokens.output.audio",
    ] as const;
    const transcriptionCategories = [
      "tokens.input.audio",
      "tokens.input.text",
      "tokens.output.text",
    ] as const;
    const rows = [
      ...realtimeCategories.map((category) => {
        return { provider: "gpt-realtime-2", category };
      }),
      ...transcriptionCategories.map((category) => {
        return { provider: "gpt-4o-mini-transcribe", category };
      }),
    ];
    await writeDb
      .insert(usagePricing)
      .values(
        rows.map((row) => {
          return {
            kind: "model",
            provider: row.provider,
            category: row.category,
            unitPrice: 1,
            unitSize: 1_000_000,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          usagePricing.kind,
          usagePricing.provider,
          usagePricing.category,
        ],
        set: { unitPrice: 1, unitSize: 1_000_000, updatedAt: nowDate() },
      });
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
    const runRows = await writeDb
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, fixture.orgId),
          eq(agentRuns.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const runIds = runRows.map((row) => {
      return row.id;
    });

    await writeDb
      .delete(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(voiceChatSessions)
      .where(
        fixture.sessionIds.length > 0
          ? or(
              inArray(voiceChatSessions.id, [...fixture.sessionIds]),
              and(
                eq(voiceChatSessions.orgId, fixture.orgId),
                eq(voiceChatSessions.userId, fixture.userId),
              ),
            )
          : and(
              eq(voiceChatSessions.orgId, fixture.orgId),
              eq(voiceChatSessions.userId, fixture.userId),
            ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    if (runIds.length > 0) {
      await writeDb
        .delete(agentRunCallbacks)
        .where(inArray(agentRunCallbacks.runId, runIds));
      signal.throwIfAborted();
      await writeDb
        .delete(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, runIds));
      signal.throwIfAborted();
      await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
      await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }
    await writeDb
      .delete(agentSessions)
      .where(
        and(
          eq(agentSessions.orgId, fixture.orgId),
          eq(agentSessions.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const composeRows = await writeDb
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, fixture.orgId),
          eq(agentComposes.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const composeIds = composeRows.map((row) => {
      return row.id;
    });
    if (composeIds.length > 0) {
      await writeDb
        .delete(agentComposeVersions)
        .where(inArray(agentComposeVersions.composeId, composeIds));
      signal.throwIfAborted();
      await writeDb
        .delete(zeroAgents)
        .where(inArray(zeroAgents.id, composeIds));
      signal.throwIfAborted();
      await writeDb
        .delete(agentComposes)
        .where(inArray(agentComposes.id, composeIds));
      signal.throwIfAborted();
    }
  },
);
