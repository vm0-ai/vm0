import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  insertChatEventAgainstPrePayloadSchemaFixture,
  insertCanonicalChatEventWritesFixture,
  isLegacyVisibleChatEventFixture,
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
  it("dual-writes canonical payloads and pointers through every persistence path", async () => {
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
      userMessage: inputRejected.userMessage,
      error: "input rejected",
    });
    expect(inputRejected.payload).toHaveProperty(
      "userMessage.compatibilityProbe.nested",
      null,
    );
    expect(inputRejected.error).toBe("input rejected");

    const outputError = row(fixture.single.outputErrorId);
    expect(outputError.payload).toStrictEqual({
      content: "output failed",
      error: "output error",
    });
    expect(outputError).toMatchObject({
      content: "output failed",
      error: "output error",
    });

    const interrupt = row(fixture.single.interruptId);
    expect(interrupt).toMatchObject({
      payload: null,
      runId: fixture.single.interruptTargetRunId,
      interruptsRunId: fixture.single.interruptTargetRunId,
    });
    await expect(
      isLegacyVisibleChatEventFixture(fixture.single.interruptId),
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
      runGroupId: fixture.single.goalId,
      contextType: "goal",
      contextId: fixture.single.goalId,
    });
    expect(row(fixture.single.goalOpenId).payload).toStrictEqual({
      content: "goal opened",
    });

    expect(row(fixture.batch.thinkingId)).toMatchObject({
      thinking: "canonical thinking",
      payload: { thinking: "canonical thinking" },
    });
    expect(row(fixture.batch.runFailedId)).toMatchObject({
      content: "run failed",
      error: "runner error",
      payload: { content: "run failed", error: "runner error" },
    });
    expect(row(fixture.batch.browserCloseId).payload).toBeNull();
    expect(row(fixture.batch.goalCloseId).payload).toBeNull();
    const usage = row(fixture.batch.usageId);
    expect(usage.payload).toStrictEqual({ usage: usage.usagePayload });

    const replacementTarget = row(fixture.replacement.targetId);
    expect(replacementTarget.payload).toStrictEqual({
      userMessage: replacementTarget.userMessage,
    });
    const replacement = row(fixture.replacement.replacementId);
    expect(replacement).toMatchObject({
      revokesEventId: fixture.replacement.targetId,
      error: "replacement rejected",
      payload: {
        userMessage: replacement.userMessage,
        error: "replacement rejected",
      },
    });

    const v3Rows = await chat.listThreadEventRows(actor, thread.id);
    const v3Interrupt = v3Rows.find((candidate) => {
      return candidate.id === fixture.single.interruptId;
    });
    expect(v3Interrupt).toMatchObject({
      runId: null,
      interruptsRunId: fixture.single.interruptTargetRunId,
    });
    expect(v3Interrupt).not.toHaveProperty("payload");
    const v3GoalOutput = v3Rows.find((candidate) => {
      return candidate.id === fixture.single.goalContextEventId;
    });
    expect(v3GoalOutput).toMatchObject({
      contextType: null,
      contextId: null,
    });
  });

  it("keeps central legacy writes legal before the payload column exists", async () => {
    await expect(
      insertChatEventAgainstPrePayloadSchemaFixture(),
    ).resolves.toStrictEqual([
      {
        content: "pre-payload compatibility",
        error: null,
        eventType: "goal.open",
        seqId: 1,
      },
      {
        content: "pre-payload batch compatibility",
        error: null,
        eventType: "output.message",
        seqId: 2,
      },
      {
        content: null,
        error: null,
        eventType: "input.prompt",
        seqId: 3,
      },
      {
        content: null,
        error: "pre-payload replacement compatibility",
        eventType: "input.rejected",
        seqId: 4,
      },
    ]);
  });
});
