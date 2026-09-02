import { describe, expect, it } from "vitest";
import { PREVIOUS_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";

import { testContext } from "../../../__tests__/test-context";
import {
  insertCanonicalChatEventWritesFixture,
  isVisibleChatEventFixture,
  readCanonicalChatEventStorageFixture,
  readCanonicalRunIdCollisionSafetyFixture,
} from "../../../test-fixtures/chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

describe("canonical chat event storage", () => {
  it("writes only canonical payloads and pointers through every persistence path", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Canonical chat event storage agent",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Canonical chat event storage",
    });

    if (!actor.orgId) {
      throw new Error("Canonical storage fixture requires an org-scoped actor");
    }
    const fixture = await insertCanonicalChatEventWritesFixture({
      threadId: thread.id,
      orgId: actor.orgId,
      userId: actor.userId,
      agentId: agent.agentId,
    });
    const rows = await readCanonicalChatEventStorageFixture(fixture.eventIds);
    expect(rows).toHaveLength(fixture.eventIds.length);
    const row = (id: string) => {
      const found = rows.find((candidate) => {
        return candidate.id === id;
      });
      if (!found) {
        throw new Error(`Missing canonical chat event fixture row ${id}`);
      }
      return found;
    };

    const inputRejected = row(fixture.single.inputRejectedId);
    expect(inputRejected.payload).toStrictEqual({
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "rejected canonical input" }],
      },
      error: "input rejected",
    });

    const outputError = row(fixture.single.outputErrorId);
    expect(outputError.payload).toStrictEqual({
      content: "output failed",
      error: "output error",
    });

    const interrupt = row(fixture.single.interruptId);
    expect(interrupt).toMatchObject({
      payload: null,
      runId: fixture.single.interruptTargetRunId,
    });
    await expect(
      isVisibleChatEventFixture(fixture.single.interruptId),
    ).resolves.toBeFalsy();
    await expect(
      readCanonicalRunIdCollisionSafetyFixture({
        chatThreadId: thread.id,
        interruptEventId: fixture.single.interruptId,
        runId: fixture.single.interruptTargetRunId,
      }),
    ).resolves.toStrictEqual({
      rawRunIdCollisionExists: true,
      artifactLookupMatchedInterrupt: false,
      threadScopedArtifactLookupMatchedInterrupt: false,
      feishuDispatchMatchedInterrupt: false,
      threadScopedDispatchMatchedInterrupt: false,
    });

    expect(row(fixture.single.goalContextEventId)).toMatchObject({
      payload: { content: "goal output" },
      contextType: "goal",
      contextId: fixture.single.goalId,
    });
    expect(row(fixture.single.goalOpenId).payload).toStrictEqual({
      content: "goal opened",
    });

    expect(row(fixture.batch.thinkingId).payload).toStrictEqual({
      thinking: "canonical thinking",
    });
    expect(row(fixture.batch.runFailedId)).toMatchObject({
      payload: { content: "run failed", error: "runner error" },
      failureReason: "provider_server_error",
    });
    expect(row(fixture.batch.browserCloseId).payload).toBeNull();
    expect(row(fixture.batch.goalCloseId).payload).toBeNull();
    const usage = row(fixture.batch.usageId);
    expect(usage.payload).toStrictEqual({
      usage: {
        version: 1,
        totalCredits: 9,
        settledAt: "2026-08-10T00:00:00.000Z",
        breakdown: [
          {
            kind: "model",
            credits: 9,
            providers: [{ provider: "test", credits: 9 }],
          },
        ],
      },
    });
    const replacementTarget = row(fixture.replacement.targetId);
    expect(replacementTarget.payload).toStrictEqual({
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "replacement canonical input" }],
      },
    });
    const replacement = row(fixture.replacement.replacementId);
    expect(replacement).toMatchObject({
      revokesEventId: fixture.replacement.targetId,
      payload: {
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "replacement canonical input" }],
        },
        error: "replacement rejected",
      },
    });

    const storedRows = await chat.listThreadEventRows(actor, thread.id);
    const storedInterrupt = storedRows.find((candidate) => {
      return candidate.id === fixture.single.interruptId;
    });
    expect(storedInterrupt).toMatchObject({
      runId: fixture.single.interruptTargetRunId,
      payload: null,
    });
    expect(storedInterrupt).not.toHaveProperty("interruptsRunId");
    const storedGoalOutput = storedRows.find((candidate) => {
      return candidate.id === fixture.single.goalContextEventId;
    });
    expect(storedGoalOutput).toMatchObject({
      contextType: "goal",
      contextId: fixture.single.goalId,
      payload: { content: "goal output" },
    });
    expect(storedGoalOutput).not.toHaveProperty("runGroupId");

    const storedFailure = storedRows.find((candidate) => {
      return candidate.id === fixture.batch.runFailedId;
    });
    expect(storedFailure).toMatchObject({
      eventType: "run.failed",
      failureReason: "provider_server_error",
    });
    const previousRows = await chat.listThreadEventRows(
      actor,
      thread.id,
      { lastEventId: null, lastSeqId: 0 },
      PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
    );
    expect(
      previousRows.find((candidate) => {
        return candidate.id === fixture.batch.runFailedId;
      }),
    ).not.toHaveProperty("failureReason");
  });
});
