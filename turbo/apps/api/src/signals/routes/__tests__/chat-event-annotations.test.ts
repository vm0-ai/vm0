import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { seedChatEventAnnotationProjectionFixture } from "../../../test-fixtures/chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

function eventText(event: ChatEvent): string | undefined {
  if (
    event.eventType !== "input.prompt" &&
    event.eventType !== "input.rejected"
  ) {
    return undefined;
  }
  return event.userMessage.parts.find((part) => {
    return part.type === "text";
  })?.text;
}

function annotationForText(
  events: readonly ChatEvent[],
  text: string,
): ChatEvent["annotation"] {
  return events.find((event) => {
    return eventText(event) === text;
  })?.annotation;
}

describe("chat event annotations", () => {
  it("projects precise source links and inherits them across replacements", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Annotation projection agent",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Annotation projections",
    });

    const { claimedPendingId, rejectedPendingId } =
      await seedChatEventAnnotationProjectionFixture(thread.id);

    const events = (await chat.listThreadEvents(actor, thread.id)).events;
    expect(annotationForText(events, "slack linked")).toStrictEqual({
      kind: "slack",
      href: "https://vm0.slack.com/archives/C123/p1753257600000100",
    });
    expect(annotationForText(events, "feishu linked")).toStrictEqual({
      kind: "feishu",
      href: "https://applink.feishu.cn/client/chat/open?openChatId=oc_123",
    });
    expect(annotationForText(events, "teams channel linked")).toStrictEqual({
      kind: "teams",
      href: "https://teams.microsoft.com/l/message/19%3Achannel%40thread.tacv2/activity-1?tenantId=tenant-1",
    });
    expect(annotationForText(events, "teams personal unlinked")).toStrictEqual({
      kind: "teams",
    });
    expect(
      annotationForText(events, "telegram supergroup linked"),
    ).toStrictEqual({
      kind: "telegram",
      href: "https://t.me/c/1234567890/42",
    });
    expect(annotationForText(events, "telegram dm unlinked")).toStrictEqual({
      kind: "telegram",
    });
    expect(annotationForText(events, "telegram group unlinked")).toStrictEqual({
      kind: "telegram",
    });
    expect(
      annotationForText(events, "github issue comment linked"),
    ).toStrictEqual({
      kind: "github",
      href: "https://github.com/vm0-ai/vm0/issues/24218#issuecomment-123456",
    });
    expect(
      annotationForText(events, "github pull request linked"),
    ).toStrictEqual({
      kind: "github",
      href: "https://github.com/vm0-ai/vm0/pull/24219",
    });
    const claimedReplacement = events.find((event) => {
      return event.revokesEventId === claimedPendingId;
    });
    expect(claimedReplacement?.annotation).toStrictEqual({
      kind: "github",
      href: "https://github.com/vm0-ai/vm0/issues/24218#issuecomment-654321",
    });
    const rejectedReplacement = events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === rejectedPendingId
      );
    });
    expect(rejectedReplacement?.annotation).toStrictEqual({
      kind: "teams",
      href: "https://teams.microsoft.com/l/message/19%3Areject%40thread.tacv2/activity-rejected?tenantId=tenant-2",
    });
  });
});
